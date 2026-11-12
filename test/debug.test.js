import assert from 'node:assert/strict';
import test from 'node:test';
import { createTestNetwork, joinRoom } from '../p2p-core.js';

test('connection diagnostics are opt-in and report peer admission without exposing room secrets', async () => {
  const network = createTestNetwork();
  const options = { app: 'debug-test', network, room: 'private-room-name', password: 'private-room-password',
    protocol: 3, kinds: ['example'] };
  const host = joinRoom({ ...options, debug: true });
  const guest = joinRoom({ ...options, profile: { name: 'private-profile' } });
  try {
    await Promise.all([host.ready, guest.ready]);
    assert.equal(guest.debugReport(), null);
    const joined = new Promise(resolve => host.count() ? resolve() : host.onPeerJoin(resolve));
    await joined;
    await guest.send('example', 'private-message');
    const report = host.debugReport();
    for (const event of ['room.join', 'transport.start', 'peer.transport-joined', 'peer.hello-received', 'peer.accepted']) {
      assert.ok(report.events.some(entry => entry.event === event), event);
    }
    const serialized = JSON.stringify(report);
    for (const secret of [options.room, options.password, guest.selfId, 'private-profile', 'private-message']) {
      assert.ok(!serialized.includes(secret), secret);
    }
    report.events[0].event = 'modified';
    assert.equal(host.debugReport().events[0].event, 'room.join');
  } finally {
    guest.leave();
    host.leave();
  }
  assert.equal(host.debugReport().events.at(-1).event, 'room.left');
});

test('connection diagnostics record a protocol mismatch', async () => {
  const network = createTestNetwork();
  const host = joinRoom({ app: 'debug-test', network, protocol: 3, debug: true });
  const refused = new Promise(resolve => host.onRefused(resolve));
  const guest = joinRoom({ app: 'debug-test', network, protocol: 2 });
  try {
    await refused;
    assert.ok(host.debugReport().events.some(entry => entry.event === 'peer.refused' && entry.reason === 'version'));
  } finally {
    guest.leave();
    host.leave();
  }
});

test('WebRTC diagnostics capture failed and selected candidate pairs without addresses', async () => {
  const { traceConnection } = await import('../vendor/trystero/src/debug.js');
  const connection = Object.assign(new EventTarget(), {
    connectionState: 'new', iceConnectionState: 'new', iceGatheringState: 'new', signalingState: 'stable',
    async getStats() {
      return new Map([
        ['local', { type: 'local-candidate', candidateType: 'host', address: '192.168.1.20', protocol: 'udp' }],
        ['remote', { type: 'remote-candidate', candidateType: 'relay', address: '198.51.100.8', protocol: 'udp' }],
        ['pair', { type: 'candidate-pair', state: 'succeeded', localCandidateId: 'local', remoteCandidateId: 'remote',
          requestsSent: 3, responsesReceived: 1, currentRoundTripTime: 0.02 }],
        ['transport', { type: 'transport', selectedCandidatePairId: 'pair' }],
      ]);
    },
  });
  const events = [];
  const trace = traceConnection({ onDebug: (event, details) => events.push({ event, ...details }),
    nextDebugAttempt: () => 1 }, connection, true);
  connection.connectionState = 'failed';
  connection.dispatchEvent(new Event('connectionstatechange'));
  assert.ok(events.some(entry => entry.event === 'rtc.state' && entry.connection === 'failed'));
  await trace.stats();
  const stats = events.find(entry => entry.event === 'rtc.stats');
  assert.equal(stats.selected.remote.type, 'relay');
  assert.equal(stats.selected.rttMs, 20);
  assert.equal(stats.requestsSent, 3);
  assert.equal(stats.responsesReceived, 1);
  assert.doesNotMatch(JSON.stringify(events), /192\.168\.1\.20|198\.51\.100\.8/);
});
