// Two-peer journeys on the in-memory test network: one test per scenario in src/SCENARIOS.md and
// extras/SCENARIOS.md, named exactly after its title. Given = arrange, When = act, Then = assert.
// No browser, no internet, no fixed waits: each step waits for network.settle() or for the event it needs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { joinRoom, createTestNetwork } from '../p2p-core.js';
import { matchmake } from '../extras/matchmaking.js';
import { presence } from '../extras/presence.js';
import { sharedState } from '../extras/state.js';
import { describeStatus } from '../extras/status-ui.js';
import { nextEvent, record } from './events.mjs';

/** Named players in one room of one test network; `leave()` ends them all. */
function players(names, options = {}) {
  const network = createTestNetwork();
  const rooms = {};
  for (const name of names) {
    const extra = typeof options === 'function' ? options(name) : options;
    rooms[name] = joinRoom({ app: 'journeys', room: 'lobby', network, profile: { name }, ...extra });
  }
  return { network, ...rooms, leave: () => Object.values(rooms).forEach((r) => { try { r.leave(); } catch {} }) };
}

// ---------------------------------------------------------------- rooms (src/SCENARIOS.md)

test('Two players meet in a room', async () => {
  // Given Ann and Ben open the same game and room on one network
  const { network, ann, ben, leave } = players(['ann', 'ben']);
  try {
    // When the network settles
    await network.settle();
    // Then Ann sees Ben with his profile name
    assert.deepEqual(ann.peers().map((p) => [p.id, p.profile.name]), [[ben.selfId, 'ben']]);
    // And Ben sees Ann with hers
    assert.deepEqual(ben.peers().map((p) => [p.id, p.profile.name]), [[ann.selfId, 'ann']]);
  } finally { leave(); }
});

test('A message to everyone reaches every other player', async () => {
  // Given Ann, Ben and Cat are in one room
  const { network, ann, ben, cat, leave } = players(['ann', 'ben', 'cat']);
  try {
    const heard = { ann: [], ben: [], cat: [] };
    for (const [name, room] of Object.entries({ ann, ben, cat })) room.onMessage('chat', (text, from) => heard[name].push([text, from]));
    await network.settle();
    // When Ann sends the chat message "hello" to everyone
    await ann.send('chat', 'hello');
    await network.settle();
    // Then Ben and Cat each receive "hello" from Ann
    assert.deepEqual(heard.ben, [['hello', ann.selfId]]);
    assert.deepEqual(heard.cat, [['hello', ann.selfId]]);
    // And Ann does not receive her own message
    assert.deepEqual(heard.ann, []);
  } finally { leave(); }
});

test('A message to one player reaches only that player', async () => {
  // Given Ann, Ben and Cat are in one room
  const { network, ann, ben, cat, leave } = players(['ann', 'ben', 'cat']);
  try {
    const benHeard = record((fn) => ben.onMessage('secret', fn));
    const catHeard = record((fn) => cat.onMessage('secret', fn));
    await network.settle();
    // When Ann sends a secret to Ben only
    await ann.send('secret', 'the key is under the mat', ben.selfId);
    await network.settle();
    // Then Ben receives the secret
    assert.deepEqual(benHeard.map(([data]) => data), ['the key is under the mat']);
    // And Cat receives nothing
    assert.deepEqual(catHeard, []);
  } finally { leave(); }
});

test('A player who leaves disappears for the others', async () => {
  // Given Ann and Ben are in one room
  const { network, ann, ben, leave } = players(['ann', 'ben']);
  try {
    await network.settle();
    const left = nextEvent(ann.onPeerLeave, (id) => id === ben.selfId, 'Ben leaving');
    // When Ben leaves the room
    ben.leave();
    // Then Ann is told Ben left
    const [, peer] = await left;
    assert.equal(peer.profile.name, 'ben');
    // And Ann's room counts no other players
    assert.equal(ann.count(), 0);
  } finally { leave(); }
});

test('A lost connection is seen as a leave', async () => {
  // Given Ann and Ben are in one room
  const { network, ann, ben, leave } = players(['ann', 'ben']);
  try {
    await network.settle();
    const left = nextEvent(ann.onPeerLeave, (id) => id === ben.selfId, 'Ben dropping out');
    // When Ben's connection drops
    network.disconnect(ben.selfId);
    // Then Ann is told Ben left
    await left;
    assert.equal(ann.count(), 0);
  } finally { leave(); }
});

test('A player on another protocol version is refused with a reason', async () => {
  // Given Ann's game speaks protocol 2
  // When Ben joins with protocol 1
  const { network, ann, ben, leave } = players(['ann', 'ben'], (name) => ({ protocol: name === 'ann' ? 2 : 1 }));
  try {
    ann.onError(() => {}); // the version refusal is also reported as an error; the reason is what we check
    ben.onError(() => {});
    const refused = nextEvent(ann.onRefused, (id) => id === ben.selfId, 'Ann refusing Ben');
    await network.settle();
    // Then Ann refuses Ben with the reason "version"
    const [, reason] = await refused;
    assert.equal(reason, 'version');
    // And neither counts the other as a player
    assert.equal(ann.count(), 0);
    assert.equal(ben.count(), 0);
  } finally { leave(); }
});

test('A private room lets in only players with the same password', async () => {
  // Given Ann opens a room with the password "secret"
  // When Ben joins with "secret" and Cat joins with "wrong"
  const { network, ann, ben, cat, leave } = players(['ann', 'ben', 'cat'], (name) => ({ password: name === 'cat' ? 'wrong' : 'secret' }));
  try {
    await network.settle();
    // Then Ann and Ben see each other
    assert.deepEqual(ann.peers().map((p) => p.id), [ben.selfId]);
    assert.deepEqual(ben.peers().map((p) => p.id), [ann.selfId]);
    // And Cat sees nobody
    assert.equal(cat.count(), 0);
  } finally { leave(); }
});

test('A full room refuses one more player', async () => {
  // Given Ann's room allows one other player
  const network = createTestNetwork();
  const ann = joinRoom({ app: 'journeys', network, maxPeers: 1 });
  const refused = record(ann.onRefused);
  const rooms = [ann];
  try {
    // When Ben and then Cat join
    const ben = joinRoom({ app: 'journeys', network });
    rooms.push(ben);
    await network.settle();
    const cat = joinRoom({ app: 'journeys', network });
    rooms.push(cat);
    await network.settle();
    // Then Ann plays with Ben
    assert.deepEqual(ann.peers().map((p) => p.id), [ben.selfId]);
    // And Ann refuses Cat with the reason "full"
    assert.deepEqual(refused, [[cat.selfId, 'full']]);
  } finally { rooms.forEach((r) => r.leave()); }
});

test('Everyone agrees on the host, and the next one takes over when the host leaves', async () => {
  // Given three players are in one room
  const { network, ann, ben, cat, leave } = players(['ann', 'ben', 'cat']);
  try {
    await network.settle();
    const sent = network.log.length;
    // When they compare who is host
    const hosts = [ann, ben, cat].map((r) => r.hostId());
    // Then all three name the same player, without sending a message about it
    assert.equal(new Set(hosts).size, 1);
    assert.equal([ann, ben, cat].filter((r) => r.isHost()).length, 1);
    assert.equal(network.log.length, sent, 'no message was sent to agree');
    // And when that host leaves, the two others agree on a new host
    const host = [ann, ben, cat].find((r) => r.isHost());
    const rest = [ann, ben, cat].filter((r) => r !== host);
    const changes = rest.map((r) => nextEvent(r.onHostChange, () => true, 'a new host'));
    host.leave();
    const [[first], [second]] = await Promise.all(changes);
    assert.equal(first, second);
    assert.ok(first !== host.selfId && rest.some((r) => r.selfId === first));
  } finally { leave(); }
});

test('Data that fails validation never reaches the game', async () => {
  // Given Ben's game accepts only moves with a number x
  const { network, ann, ben, leave } = players(['ann', 'ben'], (name) => (name === 'ben'
    ? { validate: { move: (data) => Number.isFinite(data?.x) } } : {}));
  try {
    const moves = record((fn) => ben.onMessage('move', fn));
    await network.settle();
    // When Ann sends a move with x "far" and then a move with x 3
    await ann.send('move', { x: 'far' });
    await ann.send('move', { x: 3 });
    await network.settle();
    // Then Ben's game receives only the move with x 3
    assert.deepEqual(moves.map(([data]) => data), [{ x: 3 }]);
    // And Ben's room counts one invalid message dropped
    assert.equal(ben.stats.dropped.invalid, 1);
  } finally { leave(); }
});

test('A new profile name reaches the other players', async () => {
  // Given Ann and Ben are in one room
  const { network, ann, ben, leave } = players(['ann', 'ben']);
  try {
    await network.settle();
    const updated = nextEvent(ann.onPeerUpdate, (id) => id === ben.selfId, 'Ben\'s new profile');
    // When Ben changes his name to "Bee"
    ben.setProfile({ name: 'Bee' });
    // Then Ann is told of the update
    const [, peer] = await updated;
    assert.equal(peer.profile.name, 'Bee');
    // And Ann sees Ben as "Bee"
    assert.equal(ann.peer(ben.selfId).profile.name, 'Bee');
  } finally { leave(); }
});

// ---------------------------------------------------------------- extras (extras/SCENARIOS.md)

/** Matchmakers for named players; resolves once `count` of them are matched. */
function matchmakers(names) {
  const room = players(names);
  const matches = Object.fromEntries(names.map((name) => [name, matchmake(room[name], { helloIntervalMs: 20, pendingTimeoutMs: 200 })]));
  const matched = Object.fromEntries(names.map((name) => [name, nextEvent(matches[name].onMatch, () => true, `${name} matched`)]));
  const end = () => { Object.values(matches).forEach((m) => m.leave({ keepRoom: true })); room.leave(); };
  return { room, matches, matched, end };
}

test('Two players are matched and exactly one hosts', async () => {
  // Given Ann and Ben look for a 1-on-1 match in the same room
  const { room, matched, end } = matchmakers(['ann', 'ben']);
  try {
    // When matchmaking finishes
    const [[forAnn], [forBen]] = await Promise.all([matched.ann, matched.ben]);
    // Then each is matched with the other
    assert.equal(forAnn.opponentId, room.ben.selfId);
    assert.equal(forBen.opponentId, room.ann.selfId);
    // And exactly one of them is the host
    assert.equal([forAnn.host, forBen.host].filter(Boolean).length, 1);
  } finally { end(); }
});

test('A third player is told the room is full and never hears the game', async () => {
  // Given Ann, Ben and Cat look for a 1-on-1 match in the same room
  const names = ['ann', 'ben', 'cat'];
  const room = players(names);
  const matches = names.map((name) => matchmake(room[name], { helloIntervalMs: 20, pendingTimeoutMs: 200 }));
  try {
    const matchedSet = new Set();
    const fullSet = new Set();
    const settled = new Promise((resolve, reject) => {
      const deadline = setTimeout(() => reject(new Error(`timed out: ${matchedSet.size} matched, ${fullSet.size} told full`)), 8000);
      const check = () => {
        if (matchedSet.size === 2 && [...fullSet].some((m) => !matchedSet.has(m))) { clearTimeout(deadline); resolve(); }
      };
      matches.forEach((m) => { m.onMatch(() => { matchedSet.add(m); check(); }); m.onRoomFull(() => { fullSet.add(m); check(); }); });
    });
    // When two of them are matched
    await settled;
    const pair = [...matchedSet];
    assert.equal(pair.length, 2);
    // Then the third is told the room is full
    const outsider = matches.find((m) => !matchedSet.has(m));
    assert.ok(fullSet.has(outsider), 'the third player was told the room is full');
    // And a move between the matched two never reaches the third
    const outsiderHeard = record((fn) => outsider.on('move', fn));
    const arrived = nextEvent((fn) => pair[1].on('move', fn), () => true, 'the move');
    pair[0].send('move', 'secret');
    await arrived;
    await room.network.settle();
    assert.deepEqual(outsiderHeard, []);
    assert.throws(() => outsider.send('move', 'x'), /No opponent/);
  } finally { matches.forEach((m) => m.leave({ keepRoom: true })); room.leave(); }
});

test("A matched player's move reaches the opponent", async () => {
  // Given Ann and Ben are matched
  const { matches, matched, end } = matchmakers(['ann', 'ben']);
  try {
    await Promise.all([matched.ann, matched.ben]);
    const arrived = nextEvent((fn) => matches.ben.on('move', fn), () => true, 'Ann\'s move');
    // When Ann sends the move "e4"
    matches.ann.send('move', 'e4');
    // Then Ben receives "e4"
    const [move] = await arrived;
    assert.equal(move, 'e4');
  } finally { end(); }
});

test('The opponent leaving is reported', async () => {
  // Given Ann and Ben are matched
  const { room, matches, matched, end } = matchmakers(['ann', 'ben']);
  try {
    await Promise.all([matched.ann, matched.ben]);
    const gone = nextEvent(matches.ann.onOpponentLeave, () => true, 'the opponent leaving');
    // When Ben leaves
    room.ben.leave();
    // Then Ann is told her opponent left
    await gone;
  } finally { end(); }
});

test("A moving player's position reaches the others", async () => {
  // Given Ann and Ben share their positions with presence
  const { network, ann, ben, leave } = players(['ann', 'ben']);
  const me = { x: 0, y: 0 };
  const annShares = presence(ann, { hz: 20 });
  const benSees = presence(ben, { hz: 20 });
  try {
    await network.settle();
    annShares.follow(() => me);
    // When Ann moves to x 40, y 25
    const update = nextEvent(benSees.onUpdate, (id, state) => id === ann.selfId && state.x === 40, 'Ann\'s new position');
    me.x = 40;
    me.y = 25;
    annShares.push();
    await update;
    // Then Ben's latest state for Ann is x 40, y 25
    assert.deepEqual(benSees.latest(ann.selfId), { x: 40, y: 25 });
  } finally { annShares.stop(); benSees.stop(); leave(); }
});

test('Shared state reaches everyone, including a player who joins late', async () => {
  // Given Ann and Ben share state that starts at level 1
  const { network, ann, ben, leave } = players(['ann', 'ben']);
  const annState = sharedState(ann, { initial: { level: 1 } });
  const benState = sharedState(ben, { initial: { level: 1 } });
  let cat;
  let catState;
  try {
    await network.settle();
    // When Ann sets the level to 2
    annState.set('level', 2);
    await network.settle();
    // Then Ben sees level 2
    assert.equal(benState.get('level'), 2);
    // And Cat, who joins afterwards, also sees level 2
    cat = joinRoom({ app: 'journeys', room: 'lobby', network, profile: { name: 'cat' } });
    catState = sharedState(cat);
    await network.settle();
    assert.equal(catState.get('level'), 2);
  } finally { annState.stop(); benState.stop(); catState?.stop(); cat?.leave(); leave(); }
});

test('The status line says how many players are here', async () => {
  // Given Ann and Ben are in one room on the test network
  const { network, ann, leave } = players(['ann', 'ben']);
  try {
    await network.settle();
    // When Ann describes her room's status
    const line = describeStatus(ann.status());
    // Then it reads "1 other player · test network"
    assert.equal(line, '1 other player · test network');
  } finally { leave(); }
});
