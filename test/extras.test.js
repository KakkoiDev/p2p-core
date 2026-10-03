import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { matchmake, chooseHostCandidate, roomIsFull } from '../extras/matchmaking.js';
import { presence, sampleAt } from '../extras/presence.js';
import { sharedState } from '../extras/state.js';
import { describeStatus, diagnose } from '../extras/status-ui.js';
import { joinRoom, createTestNetwork } from '../p2p-core.js';
import { testRooms, until, wait } from './helpers.js';

test('matchmaking pairs two players, and the lower id hosts', async () => {
  const { network, rooms: [a, b], done } = testRooms(2);
  const ma = matchmake(a, { helloIntervalMs: 20 });
  const mb = matchmake(b, { helloIntervalMs: 20 });
  try {
    const outcomes = [];
    ma.onMatch((m) => outcomes.push([a.selfId, m.host, m.opponentId]));
    mb.onMatch((m) => outcomes.push([b.selfId, m.host, m.opponentId]));
    await until(() => ma.matched && mb.matched, 3000, 'a match');
    const lower = [a.selfId, b.selfId].sort()[0];
    for (const [id, host, opponent] of outcomes) {
      assert.equal(host, id === lower);
      assert.equal(opponent, id === a.selfId ? b.selfId : a.selfId);
    }
    const got = [];
    mb.on('move', (d) => got.push(d));
    ma.send('move', 'e4');
    await until(() => got.length, 1000, 'a move');
    assert.deepEqual(got, ['e4']);
  } finally { ma.leave({ keepRoom: true }); mb.leave({ keepRoom: true }); done(); }
});

test('matchmaking: a third player is told the room is full, and never hears the game', async () => {
  const { rooms, done } = testRooms(3);
  const matches = rooms.map((r) => matchmake(r, { helloIntervalMs: 20, pendingTimeoutMs: 200 }));
  try {
    const full = [];
    matches.forEach((m, i) => m.onRoomFull(() => full.push(i)));
    await until(() => matches.filter((m) => m.matched).length === 2 && full.length === 1, 4000, 'two matched, one full');
    const outsider = matches.find((m) => !m.matched);
    const heard = [];
    outsider.on('move', (d) => heard.push(d));
    matches.find((m) => m.matched).send('move', 'secret');
    await wait(30);
    assert.deepEqual(heard, []);
    assert.throws(() => outsider.send('move', 'x'), /No opponent/);
  } finally { matches.forEach((m) => m.leave({ keepRoom: true })); done(); }
});

test('matchmaking: opponent leaving is reported', async () => {
  const { network, rooms: [a, b], done } = testRooms(2);
  const ma = matchmake(a, { helloIntervalMs: 20 });
  const mb = matchmake(b, { helloIntervalMs: 20 });
  try {
    let gone = 0;
    ma.onOpponentLeave(() => gone++);
    await until(() => ma.matched && mb.matched, 3000, 'a match');
    mb.leave();
    await until(() => gone === 1, 2000, 'leave notice');
    assert.equal(ma.matched, false);
  } finally { ma.leave({ keepRoom: true }); done(); }
});

test('matchmaking: lost first hellos are recovered by re-announcing (bare trystero rooms)', async () => {
  const rooms = new Map();
  const withheld = new Set(['a', 'b']);
  function room(id) {
    const handlers = new Map();
    const r = {
      onPeerJoin(fn) { r.join = fn; },
      onPeerLeave() {},
      makeAction(name) {
        return [(packet, target) => {
          if (name === 'hello' && withheld.has(id)) { withheld.delete(id); return; }
          for (const [peerId, other] of rooms) {
            if (peerId !== id && (!target || target === peerId)) queueMicrotask(() => other.handlers.get(name)?.(packet, id));
          }
        }, (fn) => handlers.set(name, fn)];
      },
      leave() { rooms.delete(id); },
      handlers,
    };
    rooms.set(id, r);
    return r;
  }
  const a = matchmake(room('a'), { selfId: 'a', helloIntervalMs: 10 });
  const b = matchmake(room('b'), { selfId: 'b', helloIntervalMs: 10 });
  try {
    rooms.get('a').join('b');
    rooms.get('b').join('a');
    await until(() => a.matched && b.matched, 1000, 'recovery');
  } finally { a.leave(); b.leave(); }
});

test('matchmaking helpers', () => {
  const peers = new Map([['c', { waiting: true }], ['b', { waiting: true }], ['0', { waiting: true }]]);
  assert.equal(chooseHostCandidate('a', peers), 'b');
  assert.equal(chooseHostCandidate('z', peers), null);
  assert.equal(roomIsFull(new Map([['x', { waiting: false }], ['y', { waiting: false }]])), true);
  assert.equal(roomIsFull(new Map([['x', { waiting: false }], ['y', { waiting: true }]])), false);
});

test('presence: interpolates numbers, keeps the rest, and skips repeats', async () => {
  const history = [{ t: 0, state: { x: 0, name: 'a', p: [0, 10] } }, { t: 100, state: { x: 10, name: 'b', p: [10, 20] } }];
  assert.deepEqual(sampleAt(history, 50), { x: 5, name: 'b', p: [5, 15] });
  assert.deepEqual(sampleAt(history, -5), history[0].state);
  assert.deepEqual(sampleAt(history, 500), history[1].state);

  const { network, rooms: [a, b], done } = testRooms(2);
  const pa = presence(a, { hz: 100, keepAliveMs: 10000, round: true });
  const pb = presence(b, { hz: 100, interpDelayMs: 0 });
  try {
    await network.settle();
    const me = { x: 1.4, y: 2 };
    pa.follow(() => me);
    await until(() => pb.latest(a.selfId), 1000, 'first position');
    assert.deepEqual(pb.latest(a.selfId), { x: 1, y: 2 });
    await wait(80);
    assert.ok(pa.stats.skipped > 3, 'standing still sends nothing new');
    const sentBefore = pa.stats.sent;
    me.x = 50;
    await until(() => pb.latest(a.selfId).x === 50, 1000, 'a move');
    assert.equal(pa.stats.sent, sentBefore + 1);
    assert.equal(pb.all().length, 1);
    pa.sleep();
    const sleeping = pa.stats.sent;
    me.x = 60;
    await wait(50);
    assert.equal(pa.stats.sent, sleeping, 'asleep means silent');
    pa.wake();
    await until(() => pb.latest(a.selfId).x === 60, 1000, 'wake');
  } finally { pa.stop(); pb.stop(); done(); }
});

test('shared state converges, and late joiners catch up', async () => {
  const network = createTestNetwork();
  const a = joinRoom({ app: 's', network });
  const b = joinRoom({ app: 's', network });
  const sa = sharedState(a, { initial: { level: 1 } });
  const sb = sharedState(b, { initial: { level: 1 } });
  try {
    await network.settle();
    sa.set('level', 2);
    sb.set({ score: 5, turn: 'x' });
    await network.settle();
    assert.deepEqual(sa.all(), sb.all());
    assert.deepEqual(sa.all(), { level: 2, score: 5, turn: 'x' });
    // Simultaneous writes to one key: both end on the same winner.
    sa.set('turn', 'A');
    sb.set('turn', 'B');
    await network.settle();
    assert.equal(sa.get('turn'), sb.get('turn'));
    sa.remove('score');
    await network.settle();
    assert.equal(sb.get('score'), undefined);
    const c = joinRoom({ app: 's', network });
    const sc = sharedState(c);
    await network.settle();
    assert.deepEqual(sc.all(), sa.all());
    c.leave();
  } finally { sa.stop(); sb.stop(); a.leave(); b.leave(); }
});

test('status text names every transport and suggests what to do', () => {
  const status = {
    peers: 0,
    transports: {
      tabs: { state: 'ready' },
      relays: { state: 'connecting', open: 0, total: 10 },
      server: { state: 'off' },
    },
  };
  assert.equal(describeStatus(status), '0 other players · internet: 0 of 10 relays answering · other tabs: on');
  assert.match(diagnose(status, 10000), /No relay is answering/);
  assert.equal(diagnose({ ...status, peers: 1 }, 10000), null);
});

const exec = promisify(execFile);
const bin = new URL('../bin/p2p-core.js', import.meta.url).pathname;

test('cli: vendor copies the browser files, and files lists them', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'p2p-vendor-'));
  try {
    const { stdout } = await exec(process.execPath, [bin, 'vendor', path.join(dir, 'vendor/p2p-core')], { cwd: dir });
    assert.match(stdout, /import \{ joinRoom \} from '\.\/vendor\/p2p-core\/p2p-core\.js'/);
    for (const file of ['p2p-core.js', 'src/room.js', 'extras/pairing-ui.js', 'extras/ui.css', 'vendor/trystero/nostr.js', 'vendor/trystero/LICENSE', 'LICENSE']) {
      assert.ok(await stat(path.join(dir, 'vendor/p2p-core', file)), file);
    }
    await assert.rejects(stat(path.join(dir, 'vendor/p2p-core/server')), 'the server stays out of the browser copy');
    const { stdout: files } = await exec(process.execPath, [bin, 'files', './x/']);
    const list = files.trim().split('\n');
    assert.ok(list.includes('./x/p2p-core.js'));
    assert.ok(list.includes('./x/vendor/trystero/src/strategy.js'));
    assert.ok(!list.some((f) => /jsqr|\.md$|LICENSE/.test(f)), 'precache list has runtime files only');
    const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url)));
    assert.equal((await exec(process.execPath, [bin, 'version'])).stdout.trim(), pkg.version);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
