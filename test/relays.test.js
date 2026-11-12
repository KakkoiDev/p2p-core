import test from 'node:test';
import assert from 'node:assert/strict';
import { RELAYS } from '../p2p-core.js';
import { REFUSING_RELAYS } from '../src/relays.js';

test('the relay list is long enough that one dead relay is not a dead app', () => {
  assert.ok(RELAYS.length >= 8);
  assert.equal(new Set(RELAYS).size, RELAYS.length, 'a relay is listed twice');
  for (const url of RELAYS) assert.match(url, /^wss:\/\/[a-z0-9.-]+(\/\S*)?$/i);
  assert.ok(Object.isFrozen(RELAYS), 'apps must not edit the shared list in place');
});

test('no relay is ever removed: older builds still dial them', () => {
  // Every relay any p2p-core release — or the apps it came from — has shipped.
  // Append to this list when you add a relay. Never delete from it.
  const published = [
    'wss://relay.snort.social', 'wss://nostr.sathoarder.com', 'wss://nostr.vulpem.com',
    'wss://relay.primal.net', 'wss://nostr.mom', 'wss://offchain.pub', 'wss://eu.purplerelay.com',
    'wss://nostr.data.haus', 'wss://relay.fountain.fm', 'wss://relay.nostromo.social',
  ];
  for (const url of published) {
    if (REFUSING_RELAYS.includes(url)) continue;
    assert.ok(RELAYS.includes(url), `${url} was removed; older builds still dial it`);
  }
});

test('relays known to refuse our notes are not dialled', () => {
  for (const url of REFUSING_RELAYS) assert.ok(!RELAYS.includes(url), `${url} refuses posts; it only adds console warnings`);
});

test('package.json and VERSION agree', async () => {
  const { readFile } = await import('node:fs/promises');
  const { VERSION } = await import('../p2p-core.js');
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url)));
  assert.equal(VERSION, pkg.version);
});

test('a relay can open after a failed handshake and restores active subscriptions on reconnect', async (t) => {
  const { makeSocket } = await import('../vendor/trystero/src/utils.js');
  const sockets = [], retries = [];
  t.mock.method(globalThis, 'setTimeout', callback => { retries.push(callback); });
  class FakeSocket {
    constructor(url) { this.url = url; this.readyState = 0; this.sent = []; sockets.push(this); }
    send(message) { this.sent.push(message); }
    open() { this.readyState = 1; this.onopen(); }
    close() { this.readyState = 3; this.onclose(); }
  }
  const originalSocket = Object.getOwnPropertyDescriptor(globalThis, 'WebSocket');
  Object.defineProperty(globalThis, 'WebSocket', { configurable: true, writable: true, value: FakeSocket });
  t.after(() => {
    if (originalSocket) Object.defineProperty(globalThis, 'WebSocket', originalSocket);
    else delete globalThis.WebSocket;
  });
  const relay = makeSocket('wss://relay.example', () => {}, true);
  const ready = relay.ready;
  sockets[0].close();
  retries.shift()();
  sockets[1].open();
  assert.equal(await ready, relay);
  const retained = '["REQ","retained",{}]';
  const removed = '["REQ","removed",{}]';
  relay.send(retained);
  relay.send(removed);
  sockets[1].close();
  relay.send('["CLOSE","removed"]');
  relay.send('["EVENT",{}]');
  retries.shift()();
  sockets[2].open();
  assert.deepEqual(sockets[2].sent, [retained]);
});

test('relay diagnostics distinguish open sockets from a completed peer connection', async () => {
  const { describeStatus, diagnose } = await import('../extras/status-ui.js');
  const status = { peers: 0, transports: { relays: { open: 0, total: 8, state: 'connecting' } } };
  assert.match(diagnose(status, 12000), /No signaling relay socket is open/);
  status.transports.relays.open = 1;
  assert.match(describeStatus(status), /1 of 8 relay sockets open/);
  assert.match(diagnose(status, 91000), /relay policy or WebRTC/);
  status.peers = 1;
  assert.equal(diagnose(status, 91000), null);
});
