/**
 * Browser scenarios: one test per scenario in examples/SCENARIOS.md (and the pairing-dialog scenarios of
 * extras/SCENARIOS.md), named exactly after its title. Real Chromium pages, the real local server, real WebRTC,
 * and trystero's real signalling through a local nostr relay.
 *
 *   npm run test:browser          (CHROMIUM=/path/to/chrome to choose the binary)
 *
 * Separate browser *contexts* stand in for separate browsers: they share no BroadcastChannel, so whatever connects
 * them is the network. Offline: a web request to a host other than this machine is refused and fails the run; a
 * socket to one is refused.
 * Controls are found by role and label (test-core's e2e rule: tools/test-core/e2e_coverage.py reads these locators);
 * the pairing dialog is built by script, so its markup is saved to .test-output/dom/ for that check. No fixed waits:
 * every step waits for the state it needs.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { startServer } from '../server/server.js';
import { startNostrRelay } from './nostr-relay.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DOM = path.join(ROOT, '.test-output/dom');
const executablePath = process.env.CHROMIUM || '/opt/pw-browsers/chromium';
const LOCAL = /^(?:localhost|127\.0\.0\.1|\[::1\])$/;

let server;
let relay;
let browser;
let base;
let room = 0;
const external = [];

before(async () => {
  mkdirSync(DOM, { recursive: true });
  server = await startServer({ root: ROOT, port: 0, log: null, version: 'e2e' });
  relay = await startNostrRelay();
  base = `http://localhost:${server.port}`;
  browser = await chromium.launch({
    executablePath,
    args: [
      // macOS: a scratch-home Chromium asks for a keychain on every launch without these two (test-core lesson).
      '--use-mock-keychain', '--password-store=basic',
      // Headless Chromium cannot resolve the mDNS names that hide local IPs, so show it the real ones. Real browsers
      // on a real Wi-Fi resolve them.
      '--disable-features=WebRtcHideLocalIpsWithMdns',
      // A fake camera, so the pairing dialog's scanner can start and stop.
      '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream',
    ],
  });
});

after(async () => {
  await browser?.close();
  await server?.close();
  await relay?.close();
  assert.deepEqual(external, [], 'no request leaves this machine');
});

/** A new "browser": a context that refuses every host but this machine. */
async function newBrowser() {
  const context = await browser.newContext();
  await context.route('**/*', (route) => {
    if (LOCAL.test(new URL(route.request().url()).hostname)) return route.continue();
    external.push(route.request().url());
    return route.abort();
  });
  // The rock paper scissors page joins in the default mode, which also knocks on the public nostr relays: those
  // sockets are refused here (the run stays offline; the tabs and the local server still connect the players).
  await context.routeWebSocket((url) => !LOCAL.test(url.hostname), (ws) => ws.close());
  return context;
}

/** Runs `fn` with `n` fresh browsers and closes them afterwards. */
async function withBrowsers(n, fn) {
  const contexts = [];
  try {
    for (let i = 0; i < n; i++) contexts.push(await newBrowser());
    return await fn(...contexts);
  } finally {
    await Promise.all(contexts.map((c) => c.close()));
  }
}

async function open(context, query) {
  const page = await context.newPage();
  page.on('pageerror', (err) => console.log('    page error:', err.message));
  await page.goto(`${base}/examples/index.html?${query}`);
  await page.waitForFunction(() => window.room);
  return page;
}
const peers = (page) => page.evaluate(() => window.room.peers().map((p) => ({ id: p.id, transport: p.transport, name: p.profile?.name })));
const waitCount = (page, n, timeout = 15000) => page.waitForFunction((want) => window.room.count() === want, n, { timeout });
const waitLog = (page, text, timeout = 5000) => page.waitForFunction(
  (t) => [...document.querySelectorAll('#log li')].some((li) => li.textContent === t), text, { timeout });

/** Types a chat message in the form, as a person does. */
async function say(page, text) {
  await page.getByLabel('Message').fill(text);
  await page.getByRole('button', { name: 'Send' }).click();
}

/** The pairing dialog's markup, for tools/test-core/e2e_coverage.py (the dialog only exists while it is open). */
async function snapshot(page, name) {
  const html = await page.locator('dialog.p2p-dialog').evaluate((d) => d.outerHTML);
  writeFileSync(path.join(DOM, `pairing-${name}.html`), `<!-- the pairing dialog, saved by e2e/browser.spec.mjs -->\n${html}\n`);
}

async function openPairingDialog(page) {
  await page.getByRole('button', { name: 'Pair a device…' }).click();
  await page.getByRole('dialog').waitFor();
  await snapshot(page, 'start');
}

// ------------------------------------------------------------ tabs

test('Two tabs of one browser meet with no network', () => withBrowsers(1, async (ctx) => {
  const r = `tabs-${++room}`;
  // Given the playground is open in one tab as "ann" in tabs mode
  const ann = await open(ctx, `mode=tabs&room=${r}&name=ann`);
  // When a second tab opens it as "ben" in the same room
  const ben = await open(ctx, `mode=tabs&room=${r}&name=ben`);
  // Then each tab sees one other player over the tabs transport
  await waitCount(ann, 1);
  await waitCount(ben, 1);
  assert.equal((await peers(ann))[0].transport, 'tabs');
  // And ann sees ben's name
  assert.equal((await peers(ann))[0].name, 'ben');
}));

/** ann and ben in two tabs of one browser, already seeing each other. */
async function twoTabs(ctx) {
  const r = `tabs-${++room}`;
  const ann = await open(ctx, `mode=tabs&room=${r}&name=ann`);
  const ben = await open(ctx, `mode=tabs&room=${r}&name=ben`);
  await waitCount(ann, 1);
  await waitCount(ben, 1);
  return { ann, ben };
}

test('A chat message typed in one tab appears in the other', () => withBrowsers(1, async (ctx) => {
  // Given ann and ben have the playground open in two tabs of one room
  const { ann, ben } = await twoTabs(ctx);
  // When ann types "hello from ann" in the message box and presses Send
  await say(ann, 'hello from ann');
  // Then ben's log shows "ann: hello from ann"
  await waitLog(ben, 'ann: hello from ann');
  // And ann's log shows "me: hello from ann"
  await waitLog(ann, 'me: hello from ann');
}));

test('Arrow keys move my dot in the other tab', () => withBrowsers(1, async (ctx) => {
  // Given ann and ben have the playground open in two tabs of one room
  const { ann, ben } = await twoTabs(ctx);
  await ben.waitForFunction(() => Number.isFinite(window.players.all()[0]?.state?.x));
  const before = await ben.evaluate(() => window.players.all()[0].state.x);
  // When ann focuses the playground and presses the right arrow five times
  await ann.locator('#field').focus();
  for (let i = 0; i < 5; i++) await ann.keyboard.press('ArrowRight');
  // Then ann's dot moves right in ben's tab (the dot starts at most at x 700 of 800, so five 20 px steps all count)
  await ben.waitForFunction((x) => {
    const now = window.players.all()[0]?.state?.x;
    return Number.isFinite(now) && now - x >= 90;
  }, before, { timeout: 5000 });
}));

test('Closing a tab removes its player', () => withBrowsers(1, async (ctx) => {
  // Given ann and ben have the playground open in two tabs of one room
  const { ann, ben } = await twoTabs(ctx);
  // When ben's tab closes
  await ben.close();
  // Then ann sees no other player
  await waitCount(ann, 0);
  // And ann's log says "ben left"
  await waitLog(ann, 'ben left');
}));

test('The connection badge counts the other players', () => withBrowsers(1, async (ctx) => {
  const r = `badge-${++room}`;
  // Given ann has the playground open alone in tabs mode
  const ann = await open(ctx, `mode=tabs&room=${r}&name=ann`);
  const badge = ann.getByRole('status');
  await ann.waitForFunction(() => document.querySelector('.p2p-badge').textContent.startsWith('0 other players'));
  // When ben opens it in another tab of the same room
  await open(ctx, `mode=tabs&room=${r}&name=ben`);
  // Then ann's badge reads "1 other player" and "other tabs: on"
  await ann.waitForFunction(() => document.querySelector('.p2p-badge').textContent.startsWith('1 other player '));
  assert.match(await badge.textContent(), /^1 other player · other tabs: on$/);
}));

test('Choosing a mode reloads the playground in that mode', () => withBrowsers(1, async (ctx) => {
  // Given the playground is open in offline mode
  const page = await open(ctx, `mode=offline&server=off&room=mode-${++room}&name=ann`);
  // When I choose "tabs — this browser only" in the Mode list
  await Promise.all([
    page.waitForURL(/[?&]mode=tabs\b/),
    page.getByLabel('Mode').selectOption({ label: 'tabs — this browser only' }),
  ]);
  // Then the page reloads with mode=tabs in its address
  await page.waitForFunction(() => window.room);
  assert.equal(new URL(page.url()).searchParams.get('mode'), 'tabs');
  // And the room plans only the tabs transport
  assert.deepEqual(await page.evaluate(() => Object.keys(window.room.status().transports)), ['tabs']);
}));

// ------------------------------------------------------------ local server

test('Two browsers meet through the local server they were loaded from', () => withBrowsers(2, async (ctx1, ctx2) => {
  const r = `srv-${++room}`;
  // Given two browsers open the playground in offline mode, in one room
  const ann = await open(ctx1, `mode=offline&room=${r}&name=ann`);
  const ben = await open(ctx2, `mode=offline&room=${r}&name=ben`);
  // When the server introduces them
  await waitCount(ann, 1);
  await waitCount(ben, 1);
  // Then each sees the other over the server transport
  assert.equal((await peers(ann))[0].transport, 'server');
  assert.equal((await peers(ben))[0].transport, 'server');
  // And a chat message from one arrives in the other
  await say(ben, 'over the lan');
  await waitLog(ann, 'ben: over the lan');
}));

test('Each player is reached the best way', () => withBrowsers(2, async (ctx1, ctx2) => {
  const r = `srv-${++room}`;
  // Given ann and ben meet through the local server in two browsers
  const ann = await open(ctx1, `mode=offline&room=${r}&name=ann`);
  const ben = await open(ctx2, `mode=offline&room=${r}&name=ben`);
  await waitCount(ann, 1);
  await waitCount(ben, 1);
  // When cat opens a second tab in ann's browser
  const cat = await open(ctx1, `mode=offline&room=${r}&name=cat`);
  await waitCount(cat, 2);
  await waitCount(ben, 2);
  // Then cat reaches ann by tab and ben by the server
  const via = Object.fromEntries((await peers(cat)).map((p) => [p.name, p.transport]));
  assert.deepEqual(via, { ann: 'tabs', ben: 'server' });
}));

test('Tabs of one browser ignore each other when same-browser play is off', () => withBrowsers(2, async (ctx1, ctx2) => {
  const r = `sib-${++room}`;
  // Given ann and ben open two tabs of one browser with same-browser play off
  const ann = await open(ctx1, `mode=offline&room=${r}&sameBrowser=0&name=ann`);
  const ben = await open(ctx1, `mode=offline&room=${r}&sameBrowser=0&name=ben`);
  // When cat joins the room from another browser
  const cat = await open(ctx2, `mode=offline&room=${r}&name=cat`);
  // Then cat sees both
  await waitCount(cat, 2);
  // And ann and ben see only cat, even through the server: both have heard cat (who joined after them both), and a
  // message ben sends to everyone reaches cat, never ann
  await waitCount(ann, 1);
  await waitCount(ben, 1);
  await say(ben, 'only cat hears this');
  await waitLog(cat, 'ben: only cat hears this');
  await say(cat, 'both hear this');
  await waitLog(ann, 'cat: both hear this');
  assert.deepEqual((await peers(ann)).map((p) => p.name), ['cat']);
  assert.deepEqual((await peers(ben)).map((p) => p.name), ['cat']);
  assert.equal(await ann.evaluate(() => document.getElementById('log').textContent.includes('only cat hears this')), false);
}));

// ------------------------------------------------------------ pairing by code (the API)

/** ann invites, `joiner` accepts, ann finishes: the pairing handshake through the room's API. */
async function pairByCode(ann, joiner, name) {
  const invite = await ann.evaluate(async (n) => { window[n] = await window.room.pair.invite(); return window[n].code; }, name);
  const answer = await joiner.evaluate(async (code) => (await window.room.pair.accept(code)).code, invite);
  await ann.evaluate(({ n, code }) => window[n].finish(code), { n: name, code: answer });
  return { invite, answer };
}
const noServer = (r, name) => `mode=offline&server=off&room=${r}&name=${name}`;

test('Two browsers pair by code with no server and no relays', () => withBrowsers(2, async (ctx1, ctx2) => {
  const r = `pair-${++room}`;
  // Given two browsers with no server and no internet
  const ann = await open(ctx1, noServer(r, 'ann'));
  const ben = await open(ctx2, noServer(r, 'ben'));
  // When the first makes an invite code, the second accepts it, and the first finishes with the answer
  const { invite } = await pairByCode(ann, ben, 'invite');
  assert.match(invite, /^Z[A-Za-z0-9_-]+$/);
  assert.ok(invite.length < 1500, `an invite small enough for a QR code (${invite.length} chars)`);
  // Then both are paired over the pair transport, on a direct local route
  await waitCount(ann, 1);
  await waitCount(ben, 1);
  const [peer] = await peers(ann);
  assert.equal(peer.transport, 'pair');
  const route = await ann.evaluate((id) => window.room.route(id), peer.id);
  assert.equal(route?.path, 'direct-local', JSON.stringify(route));
  // And a chat message arrives
  await say(ann, 'paired hello');
  await waitLog(ben, 'ann: paired hello');
}));

test('A third device reaches everyone through the inviter', () => withBrowsers(3, async (ctx1, ctx2, ctx3) => {
  const r = `pair-${++room}`;
  // Given ann is paired with ben
  const ann = await open(ctx1, noServer(r, 'ann'));
  const ben = await open(ctx2, noServer(r, 'ben'));
  const cat = await open(ctx3, noServer(r, 'cat'));
  await pairByCode(ann, ben, 'invite');
  await waitCount(ben, 1);
  // When cat pairs with ann too
  await pairByCode(ann, cat, 'invite2');
  // Then cat and ben see each other through ann
  await waitCount(cat, 2);
  await waitCount(ben, 2);
  // And cat's message reaches ben
  await say(cat, 'relayed through ann');
  await waitLog(ben, 'cat: relayed through ann');
}));

test('An answer pasted as an invite gets a clear error', () => withBrowsers(2, async (ctx1, ctx2) => {
  const r = `pair-${++room}`;
  // Given cat has an answer code meant for ann
  const ann = await open(ctx1, noServer(r, 'ann'));
  const cat = await open(ctx2, noServer(r, 'cat'));
  const { answer } = await pairByCode(ann, cat, 'invite');
  // When cat pastes it where an invite goes
  const message = await cat.evaluate(async (code) => {
    try { await window.room.pair.accept(code); return 'accepted'; } catch (err) { return err.message; }
  }, answer);
  // Then the error says it is an answer code
  assert.match(message, /answer code/);
}));

// ------------------------------------------------------------ the pairing dialog (extras/SCENARIOS.md)

test('Two browsers pair through the dialog by pasting codes', () => withBrowsers(2, async (ctx1, ctx2) => {
  const r = `pairui-${++room}`;
  // Given two browsers open the playground with no server and no internet
  const ann = await open(ctx1, noServer(r, 'ann'));
  const ben = await open(ctx2, noServer(r, 'ben'));
  // When the first chooses "Invite a device" and the second pastes that code under "Join with a code" and connects
  await openPairingDialog(ann);
  await ann.getByRole('button', { name: 'Invite a device' }).click();
  const inviteBox = ann.getByLabel('Pairing code', { exact: true }).and(ann.locator('textarea'));
  await inviteBox.waitFor();
  await ann.getByRole('button', { name: 'Scan answer' }).waitFor(); // the inviter can also scan the answer
  await snapshot(ann, 'invite');
  const invite = await inviteBox.inputValue();
  await openPairingDialog(ben);
  await ben.getByRole('button', { name: 'Join with a code' }).click();
  await ben.getByLabel('Or paste the code:').fill(invite);
  await snapshot(ben, 'join');
  await ben.getByRole('button', { name: 'Connect' }).click();
  const answerBox = ben.getByLabel('Pairing code', { exact: true }).and(ben.locator('textarea'));
  await answerBox.waitFor();
  await snapshot(ben, 'answer');
  // And the first, who is also offered "Scan answer", pastes the answer code and connects
  await ann.getByLabel('Or paste the code:').fill(await answerBox.inputValue());
  await ann.getByRole('button', { name: 'Connect' }).click();
  // Then both are paired
  await waitCount(ann, 1);
  await waitCount(ben, 1);
  // And the dialog closes itself
  await ann.getByRole('dialog').waitFor({ state: 'detached' });
  await ben.getByRole('dialog').waitFor({ state: 'detached' });
}));

/** The playground with the pairing dialog showing an invite; returns the invite code. */
async function showInvite(page) {
  await openPairingDialog(page);
  await page.getByRole('button', { name: 'Invite a device' }).click();
  const box = page.getByLabel('Pairing code', { exact: true }).and(page.locator('textarea'));
  await box.waitFor();
  return box.inputValue();
}

test('The invite QR code reads back as the same code', () => withBrowsers(1, async (ctx) => {
  // Given the pairing dialog shows an invite
  const page = await open(ctx, noServer(`qr-${++room}`, 'ann'));
  const invite = await showInvite(page);
  assert.equal(await page.locator('.p2p-qr svg path').count(), 1, 'the invite is drawn as a QR code');
  // When its QR code is drawn and read back from the pixels
  const decoded = await page.evaluate(async (code) => {
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
  // Then the text read is the invite code
  assert.equal(decoded, invite);
}));

test('Copy code puts the invite on the clipboard', () => withBrowsers(1, async (ctx) => {
  await ctx.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: base });
  // Given the pairing dialog shows an invite
  const page = await open(ctx, noServer(`copy-${++room}`, 'ann'));
  const invite = await showInvite(page);
  // When I press "Copy code"
  await page.getByRole('button', { name: 'Copy code' }).click();
  // Then the clipboard holds the invite code
  await page.getByRole('button', { name: 'Copied' }).waitFor();
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), invite);
  // And the button says "Copied"
  await snapshot(page, 'copied');
}));

test('Back returns to the start of the dialog and Close cancels pairing', () => withBrowsers(1, async (ctx) => {
  // Given the pairing dialog is open
  const page = await open(ctx, noServer(`back-${++room}`, 'ann'));
  await openPairingDialog(page);
  // When I choose "Join with a code" and then "Back"
  await page.getByRole('button', { name: 'Join with a code' }).click();
  await page.getByLabel('Or paste the code:').waitFor();
  await page.getByRole('button', { name: 'Back' }).click();
  // Then I see "Invite a device" again
  await page.getByRole('button', { name: 'Invite a device' }).waitFor();
  // And when I press "Close" the dialog is gone
  await page.getByRole('button', { name: 'Close' }).click();
  await page.getByRole('dialog').waitFor({ state: 'detached' });
}));

test('Scanning starts the camera and Stop camera stops it', () => withBrowsers(1, async (ctx) => {
  await ctx.grantPermissions(['camera'], { origin: base });
  // Given the pairing dialog shows "Join with a code" on a device with a camera
  const page = await open(ctx, noServer(`scan-${++room}`, 'ann'));
  await openPairingDialog(page);
  await page.getByRole('button', { name: 'Join with a code' }).click();
  // When I press "Scan invite"
  await page.getByRole('button', { name: 'Scan invite' }).click();
  // Then the camera view shows and the button says "Stop camera"
  await page.locator('.p2p-video').waitFor({ state: 'visible' });
  await snapshot(page, 'scanning');
  // And when I press "Stop camera" the camera view hides
  await page.getByRole('button', { name: 'Stop camera' }).click();
  await page.locator('.p2p-video').waitFor({ state: 'hidden' });
  await page.getByRole('button', { name: 'Scan invite' }).waitFor();
}));

// ------------------------------------------------------------ internet mode

test('Two browsers meet over the internet through a relay', () => withBrowsers(2, async (ctx1, ctx2) => {
  const r = `net-${++room}`;
  // Given two browsers open the playground in online mode with one local nostr relay
  const q = (name, extra = '') => `mode=online&room=${r}&relays=${encodeURIComponent(relay.url)}&name=${name}${extra}`;
  const ann = await open(ctx1, q('ann', '&otherNetworks=0'));
  const ben = await open(ctx2, q('ben'));
  // When trystero signals through the relay
  await waitCount(ann, 1, 30000);
  await waitCount(ben, 1, 30000);
  // Then they connect over WebRTC on a local route, so "other networks off" still lets them in
  const [peer] = await peers(ann);
  assert.equal(peer.transport, 'relays');
  const route = await ann.evaluate((id) => window.room.route(id), peer.id);
  assert.ok(route?.path === 'direct-local' && route.local === true, JSON.stringify(route));
  // And a chat message arrives, relay health is reported, and ping answers
  await say(ann, 'over webrtc');
  await waitLog(ben, 'ann: over webrtc');
  const status = await ann.evaluate(() => window.room.status().transports.relays);
  assert.deepEqual({ open: status.open, total: status.total }, { open: 1, total: 1 });
  assert.ok(Number.isFinite(await ann.evaluate((id) => window.room.ping(id), peer.id)));
}));

// ------------------------------------------------------------ rock paper scissors (examples/match.html)

async function openMatch(context, id) {
  const page = await context.newPage();
  page.on('pageerror', (err) => console.log('    page error:', err.message));
  await page.goto(`${base}/examples/match.html#${id}`);
  await page.waitForFunction(() => window.match);
  return page;
}
const settledPhase = (page) => page.waitForFunction(() => ['matched', 'full'].includes(window.match.phase), null, { timeout: 15000 })
  .then(() => page.evaluate(() => window.match.phase));
const status = (page) => page.getByRole('status');

/** Two tabs of one link, matched. */
async function matchedPair(ctx) {
  const id = `e2e-${++room}-${Date.now()}`;
  const x = await openMatch(ctx, id);
  const y = await openMatch(ctx, id);
  assert.deepEqual(await Promise.all([settledPhase(x), settledPhase(y)]), ['matched', 'matched']);
  await x.getByRole('button', { name: 'Rock' }).and(x.locator(':enabled')).waitFor();
  await y.getByRole('button', { name: 'Rock' }).and(y.locator(':enabled')).waitFor();
  return [x, y];
}
const waitStatus = (page, pattern) => page.waitForFunction((p) => new RegExp(p).test(document.getElementById('status').textContent), pattern.source, { timeout: 5000 });

test("The invite link shows this match's address", () => withBrowsers(1, async (ctx) => {
  // Given the rock paper scissors page opens with a match id after the #
  const page = await openMatch(ctx, `link-${++room}`);
  // When I read the Invite link box
  const link = await page.getByLabel('Invite link').inputValue();
  // Then it holds the page's address, match id included
  assert.equal(link, page.url());
  assert.ok(link.endsWith(`#link-${room}`));
}));

test('Two tabs are matched and a third is told the room is full', () => withBrowsers(1, async (ctx) => {
  // Given three tabs open the same rock paper scissors link
  const id = `e2e-${++room}-${Date.now()}`;
  const pages = [];
  for (let i = 0; i < 3; i++) pages.push(await openMatch(ctx, id));
  // When matchmaking settles
  const phases = await Promise.all(pages.map(settledPhase));
  // Then two are matched and the third reads "Two people are already playing here"
  assert.equal(phases.filter((p) => p === 'matched').length, 2, JSON.stringify(phases));
  const third = pages[phases.indexOf('full')];
  assert.ok(third, JSON.stringify(phases));
  assert.match(await status(third).textContent(), /Two people are already playing here/);
}));

test('Rock beats scissors', () => withBrowsers(1, async (ctx) => {
  // Given two players are matched
  const [x, y] = await matchedPair(ctx);
  // When one picks Rock and the other Scissors
  await x.getByRole('button', { name: 'Rock' }).click();
  await y.getByRole('button', { name: 'Scissors' }).click();
  // Then the first reads "You win" and the second "You lose"
  await waitStatus(x, /^You win/);
  await waitStatus(y, /^You lose/);
}));

test('Paper against paper is a draw', () => withBrowsers(1, async (ctx) => {
  // Given two players are matched
  const [x, y] = await matchedPair(ctx);
  // When both pick Paper
  await x.getByRole('button', { name: 'Paper' }).click();
  await y.getByRole('button', { name: 'Paper' }).click();
  // Then both read "Draw"
  await waitStatus(x, /^Draw/);
  await waitStatus(y, /^Draw/);
}));
