import test from 'node:test';
import assert from 'node:assert/strict';
import { joinRoom, createTestNetwork, planTransports } from '../p2p-core.js';
import { testRooms, until, wait } from './helpers.js';

test('two rooms on a test network see each other and exchange messages', async () => {
  const { network, rooms: [a, b], done } = testRooms(2);
  try {
    const joins = [];
    a.onPeerJoin((id, peer) => joins.push([id, peer.transport]));
    const got = [];
    b.onMessage('move', (data, from, peer) => got.push([data, from, peer.id]));
    await network.settle();
    assert.deepEqual(joins, [[b.selfId, 'memory']]);
    await a.send('move', { x: 1 });
    await network.settle();
    assert.deepEqual(got, [[{ x: 1 }, a.selfId, a.selfId]]);
    assert.equal(a.count(), 1);
    assert.equal(a.peer(b.selfId).id, b.selfId);
  } finally { done(); }
});

test('rooms are separated by app, room name and password', async () => {
  const network = createTestNetwork();
  const rooms = [
    joinRoom({ app: 'one', network }),
    joinRoom({ app: 'one', network }),
    joinRoom({ app: 'two', network }),
    joinRoom({ app: 'one', room: 'other', network }),
    joinRoom({ app: 'one', password: 'secret', network }),
    joinRoom({ app: 'one', password: 'secret', network }),
    joinRoom({ app: 'one', password: 'wrong', network }),
  ];
  try {
    await network.settle();
    assert.deepEqual(rooms.map((r) => r.count()), [1, 1, 0, 0, 1, 1, 0]);
  } finally { rooms.forEach((r) => r.leave()); }
});

test('send to one peer, several peers, or everyone', async () => {
  const { network, rooms: [a, b, c], done } = testRooms(3);
  try {
    const got = { b: [], c: [] };
    b.onMessage('m', (d) => got.b.push(d));
    c.onMessage('m', (d) => got.c.push(d));
    await network.settle();
    await a.send('m', 1, b.selfId);
    await a.send('m', 2, [c.selfId]);
    await a.send('m', 3);
    await a.send('m', 4, 'nobody-here');
    await network.settle();
    assert.deepEqual(got, { b: [1, 3], c: [2, 3] });
  } finally { done(); }
});

test('onMessage(fn) hears every kind', async () => {
  const { network, rooms: [a, b], done } = testRooms(2);
  try {
    const got = [];
    b.onMessage((kind, data, from) => got.push([kind, data, from === a.selfId]));
    await network.settle();
    await a.send('one', 1);
    await a.send('two', 'x');
    await network.settle();
    assert.deepEqual(got, [['one', 1, true], ['two', 'x', true]]);
  } finally { done(); }
});

test('a message that arrives before its handler is registered is held, then delivered', async () => {
  const { network, rooms: [a, b], done } = testRooms(2);
  try {
    await network.settle();
    await a.send('start', { colour: 'white' });
    await network.settle();
    const got = [];
    b.onMessage('start', (d) => got.push(d));
    await wait(5);
    assert.deepEqual(got, [{ colour: 'white' }]);
    assert.equal(b.stats.dropped.unhandled, 0);
  } finally { done(); }
});

test('the trystero action shape works: makeAction gives [send, onReceive]', async () => {
  const { network, rooms: [a, b], done } = testRooms(2);
  try {
    const [sendMove] = a.makeAction('move');
    const [, onMove] = b.makeAction('move');
    assert.equal(a.makeAction('move'), a.makeAction('move'), 'the same pair every time, like trystero');
    const got = [];
    onMove((data, id) => got.push([data, id]));
    await network.settle();
    await sendMove({ x: 5 }, b.selfId);
    await sendMove({ x: 6 });
    await network.settle();
    assert.deepEqual(got, [[{ x: 5 }, a.selfId], [{ x: 6 }, a.selfId]]);
  } finally { done(); }
});

test('leaving is seen by everyone, and messages from a departed peer are dropped', async () => {
  const { network, rooms: [a, b], done } = testRooms(2);
  try {
    const left = [];
    a.onPeerLeave((id) => left.push(id));
    await network.settle();
    b.leave();
    await network.settle();
    assert.deepEqual(left, [b.selfId]);
    assert.equal(a.count(), 0);
    assert.throws(() => b.send('x', 1), /has been left/);
  } finally { done(); }
});

test('profiles arrive with the peer and updates are announced', async () => {
  const { network, rooms: [a, b], done } = testRooms(2, (i) => ({ profile: { name: i ? 'Bea' : 'Al' } }));
  try {
    const updates = [];
    a.onPeerUpdate((id, peer) => updates.push(peer.profile?.name));
    await network.settle();
    assert.equal(a.peer(b.selfId).profile.name, 'Bea');
    b.setProfile({ name: 'Bee' });
    await network.settle();
    assert.equal(a.peer(b.selfId).profile.name, 'Bee');
    assert.equal(updates.at(-1), 'Bee');
  } finally { done(); }
});

test('protocol mismatch: refused on both sides, with an error naming the cause', async () => {
  const network = createTestNetwork();
  const a = joinRoom({ app: 'g', network, protocol: 2 });
  const b = joinRoom({ app: 'g', network, protocol: 1 });
  const c = joinRoom({ app: 'g', network, protocol: 2 });
  try {
    const errors = [];
    a.onError((err) => errors.push(err.message));
    const refused = [];
    b.onRefused((id, reason) => refused.push(reason));
    await until(() => a.count() === 1 && c.count() === 1, 2000, 'a and c to meet');
    await network.settle();
    assert.equal(a.peer(b.selfId), null);
    assert.equal(b.count(), 0);
    assert.ok(errors.some((m) => /incompatible version/.test(m)));
    assert.ok(refused.length >= 1);
  } finally { [a, b, c].forEach((r) => r.leave()); }
});

test('messages sent before a gated peer is accepted are delivered once it is', async () => {
  const network = createTestNetwork();
  const a = joinRoom({ app: 'g', network, protocol: 1 });
  const b = joinRoom({ app: 'g', network, protocol: 1 });
  try {
    const got = [];
    b.onMessage('hi', (d) => got.push(d));
    await until(() => a.count() === 1, 2000, 'a to accept b');
    await a.send('hi', 'there');
    await until(() => got.length === 1, 2000, 'the message');
    assert.deepEqual(got, ['there']);
  } finally { a.leave(); b.leave(); }
});

test('acceptPeer decides who gets in, and sees their profile', async () => {
  const network = createTestNetwork();
  const host = joinRoom({ app: 'g', network, acceptPeer: (peer) => peer.profile?.name !== 'mallory' });
  const alice = joinRoom({ app: 'g', network, profile: { name: 'alice' } });
  const mallory = joinRoom({ app: 'g', network, profile: { name: 'mallory' } });
  try {
    await until(() => host.count() === 1, 2000, 'host to admit alice');
    await network.settle();
    assert.deepEqual(host.peers().map((p) => p.profile.name), ['alice']);
    assert.equal(mallory.peer(host.selfId), null, 'refusal is mutual');
  } finally { [host, alice, mallory].forEach((r) => r.leave()); }
});

test('maxPeers keeps the room to size', async () => {
  const { network, rooms, done } = testRooms(4, { maxPeers: 1 });
  try {
    await network.settle();
    await wait(20);
    for (const room of rooms) assert.ok(room.count() <= 1);
  } finally { done(); }
});

test('validate, rateLimit and maxMessageBytes drop what does not fit, and count it', async () => {
  const network = createTestNetwork();
  const a = joinRoom({ app: 'g', network, maxMessageBytes: 1000 });
  const b = joinRoom({
    app: 'g', network, rateLimit: 5, maxMessageBytes: 50,
    validate: { pos: (d) => Number.isFinite(d?.x) },
  });
  try {
    const got = [];
    b.onMessage('pos', (d) => got.push(d.x));
    b.onMessage('big', () => got.push('big'));
    await network.settle();
    await a.send('pos', { x: 1 });
    await a.send('pos', { x: 'nope' });
    await a.send('big', { s: 'x'.repeat(100) });
    for (let i = 0; i < 20; i++) await a.send('pos', { x: 100 + i });
    await network.settle();
    assert.equal(got[0], 1);
    assert.ok(got.length <= 11, `rate limit let ${got.length} through`);
    assert.equal(b.stats.dropped.invalid, 1);
    assert.equal(b.stats.dropped.tooBig, 1);
    assert.ok(b.stats.dropped.rateLimited >= 9);
    assert.throws(() => a.send('big', 'x'.repeat(2000)), /maxMessageBytes/);
  } finally { a.leave(); b.leave(); }
});

test('the host is the lowest id in the room, and changes when it leaves', async () => {
  const { network, rooms, done } = testRooms(3);
  try {
    await network.settle();
    const ids = rooms.map((r) => r.selfId).sort();
    for (const room of rooms) assert.equal(room.hostId(), ids[0]);
    assert.equal(rooms.filter((r) => r.isHost()).length, 1);
    const changes = [];
    const survivor = rooms.find((r) => r.selfId === ids[1]);
    survivor.onHostChange((id) => changes.push(id));
    rooms.find((r) => r.selfId === ids[0]).leave();
    await network.settle();
    assert.deepEqual(changes, [ids[1]]);
    assert.equal(survivor.isHost(), true);
  } finally { done(); }
});

test('ping measures a round trip', async () => {
  const { network, rooms: [a, b], done } = testRooms(2);
  try {
    await network.settle();
    const ms = await a.ping(b.selfId);
    assert.ok(Number.isFinite(ms) && ms >= 0);
    await assert.rejects(a.ping('nobody'), /not a peer/);
  } finally { done(); }
});

test('mistakes fail loudly with a hint', () => {
  assert.throws(() => joinRoom(), /needs options/);
  assert.throws(() => joinRoom({}), /needs an app name/);
  assert.throws(() => joinRoom({ app: 'g', mode: 'lan' }), /mode "lan"/);
  const network = createTestNetwork();
  const room = joinRoom({ app: 'g', network });
  try {
    assert.throws(() => room.send('a-very-long-kind-name', 1), /longer than 12 bytes/);
    assert.throws(() => room.send('~hi', 1), /reserved/);
    assert.throws(() => room.send('x'), /needs data/);
    assert.throws(() => room.onMessage('x'), /needs a function/);
  } finally { room.leave(); }
});

test('appId and roomId are accepted as aliases, for trystero habits', async () => {
  const network = createTestNetwork();
  const a = joinRoom({ appId: 'g', roomId: 'r', network });
  const b = joinRoom({ app: 'g', room: 'r', network });
  try {
    await network.settle();
    assert.equal(a.count(), 1);
  } finally { a.leave(); b.leave(); }
});

test('modes and allow choose the transports', () => {
  const plan = (o) => planTransports({ mode: 'auto', allow: { sameBrowser: true, sameNetwork: true, otherNetworks: true }, ...o });
  assert.deepEqual(plan({}), { tabs: true, relays: true, server: 'auto', pair: true });
  assert.deepEqual(plan({ mode: 'online' }), { tabs: true, relays: true, server: false, pair: true });
  assert.deepEqual(plan({ mode: 'offline' }), { tabs: true, relays: false, server: 'auto', pair: true });
  assert.deepEqual(plan({ mode: 'tabs' }), { tabs: true, relays: false, server: false, pair: false });
  assert.equal(plan({ mode: 'online', server: 'http://10.0.0.2:8787' }).server, 'http://10.0.0.2:8787');
  assert.deepEqual(plan({ allow: { sameBrowser: true, sameNetwork: false, otherNetworks: false } }),
    { tabs: true, relays: false, server: false, pair: false });
  assert.equal(plan({ allow: { sameBrowser: false, sameNetwork: true, otherNetworks: true } }).tabs, 'silent');
  assert.equal(plan({ allow: { sameBrowser: true, sameNetwork: false, otherNetworks: true } }).server, false);
  assert.deepEqual(plan({ network: {} }), { memory: true });
  assert.equal(plan({ transports: { relays: false } }).relays, false);
});

test('status reports every transport', async () => {
  const { network, rooms: [a, b], done } = testRooms(2);
  try {
    const seen = [];
    a.onStatus((s) => seen.push(s.peers));
    await network.settle();
    const status = a.status();
    assert.equal(status.peers, 1);
    assert.equal(status.online, true);
    assert.equal(status.transports.memory.state, 'ready');
    assert.equal(typeof (await a.route(b.selfId)).path, 'string');
  } finally { done(); }
});
