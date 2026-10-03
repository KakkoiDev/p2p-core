import test from 'node:test';
import assert from 'node:assert/strict';
import { joinRoom } from '../p2p-core.js';
import { startServer } from '../server/server.js';
import { detectServer, serverSocketUrl } from '../src/transports/server.js';
import { fakeTrystero, until, wait } from './helpers.js';

const only = (name, extra = {}) => ({
  tabs: false, relays: false, server: false, pair: false, ...extra, [name]: extra[name] ?? true,
});

test('tabs: rooms in the same browser find each other with no network', async () => {
  const opts = (selfId) => ({ app: 'tabs-test', selfId, mode: 'tabs', transports: only('tabs') });
  const a = joinRoom(opts('tab-a'));
  const b = joinRoom(opts('tab-b'));
  try {
    const got = [];
    b.onMessage('m', (d, from) => got.push([d, from]));
    await until(() => a.count() === 1 && b.count() === 1, 2000, 'tabs to meet');
    assert.equal(a.peer('tab-b').transport, 'tabs');
    await a.send('m', { hello: new Uint8Array([9]) });
    await until(() => got.length, 1000, 'message');
    assert.equal(got[0][1], 'tab-a');
    assert.deepEqual([...got[0][0].hello], [9]);
    const c = joinRoom(opts('tab-c'));
    await until(() => a.count() === 2 && c.count() === 2, 2000, 'a late tab');
    c.leave();
    await until(() => a.count() === 1, 2000, 'a tab leaving');
    assert.equal((await a.route('tab-b')).path, 'same-browser');
  } finally { a.leave(); b.leave(); }
});

test('tabs: allow.sameBrowser false keeps tabs apart on every transport', async () => {
  const fake = fakeTrystero();
  const opts = (selfId, sameBrowser) => ({
    app: 'sib', selfId, allow: { sameBrowser, sameNetwork: true, otherNetworks: true },
    transports: { tabs: true, relays: { joinRoom: fake.joinRoom(selfId), getRelaySockets: () => ({}) }, server: false, pair: false },
  });
  const a = joinRoom(opts('sib-a', false));
  const b = joinRoom(opts('sib-b', true));
  try {
    await wait(50);
    fake.connect('sib-a', 'sib-b');
    await wait(50);
    assert.equal(a.count(), 0, 'the silent tab sees nobody');
    assert.equal(b.count(), 0, 'and is not seen, even over the relays');
  } finally { a.leave(); b.leave(); }
});

test('relays: a trystero room drives joins, messages and leaves', async () => {
  const fake = fakeTrystero();
  const opts = (selfId) => ({
    app: 'r', room: 'lobby', selfId,
    transports: only('relays', { relays: { joinRoom: fake.joinRoom(selfId), getRelaySockets: () => ({}) } }),
  });
  const a = joinRoom(opts('ra'));
  const b = joinRoom(opts('rb'));
  try {
    assert.equal(fake.rooms.get('ra').config.appId, 'r');
    assert.equal(fake.rooms.get('ra').roomId, 'lobby');
    assert.deepEqual(fake.rooms.get('ra').config.relayUrls.length >= 8, true);
    const got = [];
    b.onMessage('chat', (d) => got.push(d));
    fake.connect('ra', 'rb');
    assert.equal(a.count(), 1, 'join is synchronous when nothing gates it, as with trystero');
    await a.send('chat', 'hi');
    await until(() => got.length, 1000, 'chat');
    fake.disconnect('ra', 'rb');
    assert.equal(a.count(), 0);
  } finally { a.leave(); b.leave(); }
});

test('relays: a password changes the room id and reaches trystero', () => {
  const fake = fakeTrystero();
  const a = joinRoom({
    app: 'r', room: 'lobby', password: 'pw', selfId: 'pa',
    transports: only('relays', { relays: { joinRoom: fake.joinRoom('pa'), getRelaySockets: () => ({}) } }),
  });
  try {
    const room = fake.rooms.get('pa');
    assert.equal(room.config.password, 'pw');
    assert.notEqual(room.roomId, 'lobby');
    assert.match(room.roomId, /^[0-9a-f]{32}$/);
  } finally { a.leave(); }
});

test('one peer reachable two ways is one peer, and survives losing one of them', async () => {
  const fake = fakeTrystero();
  const opts = (selfId) => ({
    app: 'dual', selfId,
    transports: { tabs: true, relays: { joinRoom: fake.joinRoom(selfId), getRelaySockets: () => ({}) }, server: false, pair: false },
  });
  const a = joinRoom(opts('da'));
  const b = joinRoom(opts('db'));
  try {
    const joins = [];
    const leaves = [];
    a.onPeerJoin((id) => joins.push(id));
    a.onPeerLeave((id) => leaves.push(id));
    await until(() => a.count() === 1, 2000, 'tabs');
    fake.connect('da', 'db');
    assert.deepEqual(joins, ['db']);
    assert.deepEqual(a.peer('db').via, ['tabs', 'relays']);
    assert.equal(a.peer('db').transport, 'tabs', 'messages take the best way');
    const got = [];
    b.onMessage('m', (d) => got.push(d));
    await a.send('m', 1);
    await until(() => got.length === 1, 1000, 'message');
    await wait(30);
    assert.deepEqual(got, [1], 'sent once, not once per transport');
    b.transport('tabs').stop();
    await until(() => a.peer('db')?.transport === 'relays', 9000, 'fall back to the relays');
    assert.deepEqual(leaves, []);
    fake.disconnect('da', 'db');
    assert.deepEqual(leaves, ['db']);
  } finally { a.leave(); b.leave(); }
});

test('allow.otherNetworks false refuses peers whose link crosses the internet', async () => {
  const fake = fakeTrystero();
  const routes = { lb: { path: 'direct-local', local: true }, lc: { path: 'direct-internet', local: false } };
  const relays = (selfId) => ({ joinRoom: fake.joinRoom(selfId), getRelaySockets: () => ({}) });
  const a = joinRoom({ app: 'lan', selfId: 'la', allow: { sameBrowser: true, sameNetwork: true, otherNetworks: false }, transports: only('relays', { relays: relays('la') }) });
  const b = joinRoom({ app: 'lan', selfId: 'lb', transports: only('relays', { relays: relays('lb') }) });
  const c = joinRoom({ app: 'lan', selfId: 'lc', transports: only('relays', { relays: relays('lc') }) });
  a.transport('relays').route = async (id) => routes[id];
  try {
    const refused = [];
    a.onRefused((id, reason) => refused.push([id, reason]));
    fake.connect('la', 'lb');
    fake.connect('la', 'lc');
    await until(() => a.count() === 1 && refused.length === 1, 2000, 'classification');
    assert.equal(a.peers()[0].id, 'lb');
    assert.deepEqual(refused, [['lc', 'not-allowed']]);
    await until(() => c.peer('la') === null, 1000, 'refusal to be mutual');
  } finally { [a, b, c].forEach((r) => r.leave()); }
});

test('server: the local server connects rooms and serves files, and finds itself', async () => {
  const server = await startServer({ root: new URL('..', import.meta.url).pathname, port: 0, log: null, version: 'test' });
  const url = `http://localhost:${server.port}/`;
  const opts = (selfId) => ({ app: 'srv', selfId, mode: 'offline', server: url, transports: only('server', { server: url }) });
  const a = joinRoom(opts('sa'));
  const b = joinRoom(opts('sb'));
  try {
    assert.equal(await detectServer(url), url);
    assert.equal(await detectServer('http://localhost:1/'), null);
    assert.equal((await fetch(`${url}p2p-core.js`)).status, 200);
    assert.equal((await fetch(`${url}__p2p-core/lib/src/room.js`)).status, 200);
    assert.ok([403, 404].includes((await fetch(`${url}..%2F..%2Fpackage.json`)).status), 'no escaping the folder');
    const got = [];
    b.onMessage('m', (d, from) => got.push([d, from]));
    await until(() => a.count() === 1 && b.count() === 1, 3000, 'server peers');
    assert.equal(a.peer('sb').transport, 'server');
    await a.send('m', { n: 1 });
    await a.send('m', { n: 2 }, 'sb');
    await until(() => got.length === 2, 2000, 'messages');
    assert.deepEqual(got, [[{ n: 1 }, 'sa'], [{ n: 2 }, 'sa']]);
    assert.equal((await a.route('sb')).path, 'local-server');
    b.leave();
    await until(() => a.count() === 0, 2000, 'leave over the server');
  } finally {
    a.leave(); b.leave();
    await server.close();
  }
});

test('server: a dropped connection reconnects and peers come back', async () => {
  const server = await startServer({ root: '.', port: 0, log: null });
  const url = `http://localhost:${server.port}`;
  const opts = (selfId) => ({ app: 'rc', selfId, transports: only('server', { server: url }) });
  const a = joinRoom(opts('ca'));
  const b = joinRoom(opts('cb'));
  try {
    await until(() => a.count() === 1, 3000, 'first meeting');
    // Pull a's socket out from under it, as a Wi-Fi blip would.
    for (const room of server.rooms.values()) room.get('ca')?.ws.finish();
    await until(() => a.count() === 0, 3000, 'a to notice');
    await until(() => a.count() === 1 && b.count() === 1, 5000, 'reconnect');
  } finally { a.leave(); b.leave(); await server.close(); }
});

test('server addresses are accepted in every form people type', () => {
  assert.equal(serverSocketUrl('http://192.168.1.20:8787'), 'ws://192.168.1.20:8787/__p2p-core/ws');
  assert.equal(serverSocketUrl('https://game.example/'), 'wss://game.example/__p2p-core/ws');
  assert.equal(serverSocketUrl('192.168.1.20:8787'), 'ws://192.168.1.20:8787/__p2p-core/ws');
  assert.equal(serverSocketUrl('ws://10.0.0.1:9/__p2p-core/ws'), 'ws://10.0.0.1:9/__p2p-core/ws');
});
