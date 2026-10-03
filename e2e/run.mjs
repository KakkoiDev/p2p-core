/**
 * Browser checks: real Chromium pages, the real local server, real WebRTC,
 * and trystero's real signalling through a local nostr relay.
 *
 *   npm run test:browser          (CHROMIUM=/path/to/chrome to choose the binary)
 *
 * Separate browser *contexts* stand in for separate browsers: they share no
 * BroadcastChannel, so whatever connects them is the network.
 */
import { chromium } from 'playwright-core';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { startServer } from '../server/server.js';
import { startNostrRelay } from './nostr-relay.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const executablePath = process.env.CHROMIUM || '/opt/pw-browsers/chromium';

let failures = 0;
const check = (ok, label, detail = '') => {
  if (ok) console.log(`  ok   ${label}`);
  else { failures++; console.log(`  FAIL ${label} ${detail}`); }
};
const section = (name) => console.log(`\n${name}`);

const server = await startServer({ root: ROOT, port: 0, log: null, version: 'e2e' });
const relay = await startNostrRelay();
const base = `http://localhost:${server.port}/examples/index.html`;
const browser = await chromium.launch({
  executablePath,
  // Headless Chromium cannot resolve the mDNS names that hide local IPs, so
  // show it the real ones. Real browsers on a real Wi-Fi resolve them.
  args: ['--disable-features=WebRtcHideLocalIpsWithMdns'],
});

let room = 0;
async function open(context, query) {
  const page = await context.newPage();
  page.on('pageerror', (err) => console.log('    page error:', err.message));
  await page.goto(`${base}?${query}`);
  await page.waitForFunction(() => window.room);
  return page;
}
const count = (page) => page.evaluate(() => window.room.count());
const peers = (page) => page.evaluate(() => window.room.peers().map((p) => ({ id: p.id, transport: p.transport, name: p.profile?.name })));
const waitCount = (page, n, timeout = 15000) => page.waitForFunction((want) => window.room.count() === want, n, { timeout }).then(() => true, () => false);
async function chatReaches(from, to, text) {
  await from.evaluate((t) => window.room.send('chat', t), text);
  return to.waitForFunction((t) => [...document.querySelectorAll('#log li')].some((li) => li.textContent.endsWith(t)), text, { timeout: 5000 }).then(() => true, () => false);
}

try {
  // ------------------------------------------------------- matchmaking
  section('Matchmaking example: two tabs pair up, a third is told the room is full');
  {
    const ctx = await browser.newContext();
    const url = `http://localhost:${server.port}/examples/match.html#e2e-${Date.now()}`;
    const pages = [];
    for (let i = 0; i < 3; i++) {
      const page = await ctx.newPage();
      await page.goto(url);
      await page.waitForFunction(() => window.match);
      pages.push(page);
    }
    const states = () => Promise.all(pages.map((p) => p.evaluate(() => window.match.phase)));
    let settled = await states();
    for (let i = 0; i < 100; i++) {
      if (settled.filter((x) => x === 'matched').length === 2 && settled.includes('full')) break;
      await pages[0].waitForTimeout(150);
      settled = await states();
    }
    check(settled.filter((x) => x === 'matched').length === 2 && settled.includes('full'), 'two matched, one full', JSON.stringify(settled));
    const [x, y] = pages.filter((_, i) => settled[i] === 'matched');
    if (x && y) {
      await x.click('[data-move=rock]');
      await y.click('[data-move=scissors]');
      check(await x.waitForFunction(() => /You win/.test(document.getElementById('status').textContent), null, { timeout: 5000 }).then(() => true, () => false), 'rock beats scissors');
    }
    await ctx.close();
  }

  // ------------------------------------------------------------------ tabs
  section('Same browser, two tabs, no network');
  {
    const r = `tabs-${++room}`;
    const ctx = await browser.newContext();
    const a = await open(ctx, `mode=tabs&room=${r}&name=ann`);
    const b = await open(ctx, `mode=tabs&room=${r}&name=ben`);
    check(await waitCount(a, 1) && await waitCount(b, 1), 'two tabs see each other');
    check((await peers(a))[0]?.transport === 'tabs', 'over the tabs transport');
    check((await peers(a))[0]?.name === 'ben', 'with the profile name');
    check(await chatReaches(a, b, 'hello from ann'), 'a chat message arrives');
    await a.focus('canvas');
    const before = await b.evaluate(() => window.players.all()[0]?.state?.x);
    for (let i = 0; i < 5; i++) await a.keyboard.press('ArrowRight');
    const moved = await b.waitForFunction((x) => {
      const now = window.players.all()[0]?.state?.x;
      return Number.isFinite(now) && Math.abs(now - x) >= 90;
    }, before, { timeout: 5000 }).then(() => true, () => false);
    check(moved, 'a dot moved in one tab moves in the other');
    await b.close();
    check(await waitCount(a, 0), 'closing a tab removes the player');
    await ctx.close();
  }

  // ---------------------------------------------------------- local server
  section('Different browsers through the local server (no internet)');
  {
    const r = `srv-${++room}`;
    const ctx1 = await browser.newContext();
    const ctx2 = await browser.newContext();
    const a = await open(ctx1, `mode=offline&room=${r}&name=ann`);
    const b = await open(ctx2, `mode=offline&room=${r}&name=ben`);
    check(await waitCount(a, 1) && await waitCount(b, 1), 'two browsers find each other via the server they were loaded from');
    check((await peers(a))[0]?.transport === 'server', 'over the server transport');
    check(await chatReaches(b, a, 'over the lan'), 'a chat message arrives');
    const c = await open(ctx1, `mode=offline&room=${r}&name=cat`);
    check(await waitCount(c, 2) && await waitCount(b, 2), 'a second tab joins, reaching one browser by tab and one by server');
    const viaC = Object.fromEntries((await peers(c)).map((p) => [p.name, p.transport]));
    check(viaC.ann === 'tabs' && viaC.ben === 'server', 'each by the best way', JSON.stringify(viaC));
    await ctx1.close();
    await ctx2.close();
  }

  // --------------------------------------------------- allow.sameBrowser = 0
  section('allow.sameBrowser = false');
  {
    const r = `sib-${++room}`;
    const ctx1 = await browser.newContext();
    const ctx2 = await browser.newContext();
    const a = await open(ctx1, `mode=offline&room=${r}&sameBrowser=0&name=ann`);
    const b = await open(ctx1, `mode=offline&room=${r}&sameBrowser=0&name=ben`);
    const c = await open(ctx2, `mode=offline&room=${r}&name=cat`);
    check(await waitCount(c, 2), 'another browser sees both');
    await a.waitForTimeout(1500);
    const names = (await peers(a)).map((p) => p.name);
    check(names.length === 1 && names[0] === 'cat', 'tabs of one browser ignore each other, even through the server', JSON.stringify(names));
    check(!(await peers(b)).some((p) => p.name === 'ann'), 'both ways');
    await ctx1.close();
    await ctx2.close();
  }

  // ----------------------------------------------------------- pairing API
  section('Pairing by code: WebRTC with no server and no relays');
  {
    const r = `pair-${++room}`;
    const ctx1 = await browser.newContext();
    const ctx2 = await browser.newContext();
    const ctx3 = await browser.newContext();
    const q = (name) => `mode=offline&server=off&room=${r}&name=${name}`;
    const a = await open(ctx1, q('ann'));
    const b = await open(ctx2, q('ben'));
    const c = await open(ctx3, q('cat'));
    const invite = await a.evaluate(async () => { window.invite = await window.room.pair.invite(); return window.invite.code; });
    check(/^Z[A-Za-z0-9_-]+$/.test(invite) && invite.length < 1500, 'an invite code small enough for a QR code', `(${invite.length} chars)`);
    const answer = await b.evaluate(async (code) => (await window.room.pair.accept(code)).code, invite);
    await a.evaluate((code) => window.invite.finish(code), answer);
    check(await waitCount(a, 1) && await waitCount(b, 1), 'two browsers paired');
    check((await peers(a))[0]?.transport === 'pair', 'over the pair transport');
    const route = await a.evaluate((id) => window.room.route(id), (await peers(a))[0].id);
    check(route?.path === 'direct-local', 'route reads as a direct local link', JSON.stringify(route));
    check(await chatReaches(a, b, 'paired hello'), 'a chat message arrives');
    // A third device pairs with ann; ben and cat reach each other through her.
    const invite2 = await a.evaluate(async () => { window.invite2 = await window.room.pair.invite(); return window.invite2.code; });
    const answer2 = await c.evaluate(async (code) => (await window.room.pair.accept(code)).code, invite2);
    await a.evaluate((code) => window.invite2.finish(code), answer2);
    check(await waitCount(c, 2) && await waitCount(b, 2), 'a third device sees everyone through the inviter');
    check(await chatReaches(c, b, 'relayed through ann'), 'messages are passed on');
    const wrong = await c.evaluate(async (code) => {
      try { await window.room.pair.accept(code); return 'accepted'; } catch (err) { return err.message; }
    }, answer2);
    check(/answer code/.test(wrong), 'an answer pasted as an invite gets a clear error', wrong);
    await ctx1.close();
    await ctx2.close();
    await ctx3.close();
  }

  // ----------------------------------------------------------- pairing UI
  section('Pairing dialog (paste flow)');
  {
    const r = `pairui-${++room}`;
    const ctx1 = await browser.newContext();
    const ctx2 = await browser.newContext();
    const a = await open(ctx1, `mode=offline&server=off&room=${r}&name=ann`);
    const b = await open(ctx2, `mode=offline&server=off&room=${r}&name=ben`);
    await a.click('#pair');
    await a.click('text=Invite a device');
    const inviteBox = a.locator('.p2p-code textarea');
    await inviteBox.waitFor();
    const invite = await inviteBox.inputValue();
    check(await a.locator('.p2p-qr svg path').count() === 1, 'the invite is drawn as a QR code');
    await b.click('#pair');
    await b.click('text=Join with a code');
    await b.fill('.p2p-input textarea', invite);
    await b.click('.p2p-input >> text=Connect');
    const answerBox = b.locator('.p2p-code textarea');
    await answerBox.waitFor();
    const answer = await answerBox.inputValue();
    await a.fill('.p2p-input textarea', answer);
    await a.click('.p2p-input >> text=Connect');
    check(await waitCount(a, 1) && await waitCount(b, 1), 'paired through the dialog');
    check(await a.locator('dialog.p2p-dialog').count() === 0, 'the dialog closes itself');
    const decoded = await a.evaluate(async (code) => {
      const { qrSvg, readQrFromImage } = await import('../extras/qr.js');
      const svg = qrSvg(code);
      const blob = new Blob([new XMLSerializer().serializeToString(svg).replaceAll('var(--p2p-qr-ink, #000)', '#000').replaceAll('var(--p2p-qr-paper, #fff)', '#fff')], { type: 'image/svg+xml' });
      const img = new Image();
      img.src = URL.createObjectURL(blob);
      await img.decode();
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = 900;
      const g = canvas.getContext('2d');
      g.imageSmoothingEnabled = false;
      g.drawImage(img, 0, 0, 900, 900);
      return readQrFromImage(g.getImageData(0, 0, 900, 900));
    }, invite);
    check(decoded === invite, 'the QR code reads back as the same code (jsQR fallback)');
    await ctx1.close();
    await ctx2.close();
  }

  // ------------------------------------------- trystero over a nostr relay
  section('Internet mode: trystero signalling through a nostr relay, then WebRTC');
  {
    const r = `net-${++room}`;
    const ctx1 = await browser.newContext();
    const ctx2 = await browser.newContext();
    const q = (name, extra = '') => `mode=online&room=${r}&relays=${encodeURIComponent(relay.url)}&name=${name}${extra}`;
    const a = await open(ctx1, q('ann', '&otherNetworks=0'));
    const b = await open(ctx2, q('ben'));
    check(await waitCount(a, 1, 30000) && await waitCount(b, 1, 30000), 'two browsers meet through the relay');
    check((await peers(a))[0]?.transport === 'relays', 'over the relays transport (WebRTC)');
    check(await chatReaches(a, b, 'over webrtc'), 'a chat message arrives');
    const route = await a.evaluate((id) => window.room.route(id), (await peers(a))[0].id);
    check(route?.path === 'direct-local' && route.local === true, 'the link reads as local, so otherNetworks=0 let it in', JSON.stringify(route));
    const status = await a.evaluate(() => window.room.status().transports.relays);
    check(status.open === 1 && status.total === 1, 'relay health is reported', JSON.stringify({ open: status.open, total: status.total }));
    const rtt = await a.evaluate((id) => window.room.ping(id), (await peers(a))[0].id);
    check(Number.isFinite(rtt), 'ping works', String(rtt));
    await ctx1.close();
    await ctx2.close();
  }
} finally {
  await browser.close();
  await server.close();
  await relay.close();
}

console.log(failures ? `\n${failures} check(s) failed` : '\nAll checks passed');
process.exit(failures ? 1 : 0);
