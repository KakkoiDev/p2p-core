import assert from 'node:assert/strict';
import test from 'node:test';
import makeStrategy from '../vendor/trystero/src/strategy.js';
import { encrypt, genKey, sha1 } from '../vendor/trystero/src/crypto.js';
import { libName, selfId, topicPath } from '../vendor/trystero/src/utils.js';

test('relay offers survive slow answers and ignore answers for earlier offers', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const connections = [];
  class Connection extends EventTarget {
    iceGatheringState = 'complete';
    signalingState = 'stable';
    connectionState = 'new';
    answers = [];
    constructor() {
      super();
      connections.push(this);
    }
    createDataChannel() {
      return Object.assign(new EventTarget(), { close() {} });
    }
    async setLocalDescription() {
      this.localDescription = { type: 'offer', sdp: 'local SDP' };
    }
    async setRemoteDescription(answer) {
      this.answers.push(answer.sdp);
    }
    close() {
      this.connectionState = 'closed';
    }
  }

  let receive;
  let subscribed;
  const ready = new Promise(resolve => { subscribed = resolve; });
  const join = makeStrategy({
    init: () => [{}],
    subscribe(_relay, _room, _peer, handler) {
      receive = handler;
      subscribed();
      return () => {};
    },
    announce() {},
  });
  join({
    appId: 'strategy-test', rtcPolyfill: Connection, onDebug() {}, nextDebugAttempt: () => 1,
  }, 'room');
  await ready;

  const baseTopic = topicPath(libName, 'strategy-test', 'room');
  const roomTopic = await sha1(baseTopic);
  const peerTopic = await sha1(topicPath(baseTopic, selfId));
  const remotePeer = 'remote-peer';
  const offer = async () => {
    let result;
    await receive(roomTopic, { peerId: remotePeer }, (_topic, raw) => { result = JSON.parse(raw); });
    return result;
  };
  const answer = async (offerId, sdp) => {
    const encrypted = await encrypt(genKey('', 'strategy-test', 'room'), sdp);
    await receive(peerTopic, { peerId: remotePeer, offerId, answer: { type: 'answer', sdp: encrypted } });
  };

  const first = await offer();
  const firstConnection = connections.at(-1);
  t.mock.timers.tick(6000);
  await answer(first.offerId, 'first answer');
  assert.deepEqual(firstConnection.answers, ['first answer']);
  await answer(first.offerId, 'duplicate answer');
  assert.deepEqual(firstConnection.answers, ['first answer']);

  t.mock.timers.tick(9000);
  const second = await offer();
  const secondConnection = connections.at(-1);
  assert.notEqual(first.offerId, second.offerId);
  await answer(first.offerId, 'stale answer');
  assert.deepEqual(secondConnection.answers, []);
  await answer(undefined, 'legacy answer');
  assert.deepEqual(secondConnection.answers, ['legacy answer']);
});
