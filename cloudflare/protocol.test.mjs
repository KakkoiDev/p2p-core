import assert from 'node:assert/strict';
import test from 'node:test';
import worker from './worker.mjs';
import { RelayRoomProtocol } from './protocol.mjs';

const room = 'mini-flow:room-key';
const makeSocket = () => ({
  readyState: 1, received: [], attachment: { room, id: null, second: 0, count: 0 },
  deserializeAttachment() { return structuredClone(this.attachment); },
  serializeAttachment(value) { this.attachment = structuredClone(value); },
  send(raw) { this.received.push(JSON.parse(raw)); },
  close() { this.readyState = 3; },
});
const send = (protocol, socket, value) => protocol.receive(socket, JSON.stringify(value));

test('Worker routes only allowed origins to the named room', async () => {
  const env = { ALLOWED_ORIGINS: 'https://mini-flow.example, https://another.example', ROOMS: {
    idFromName: name => name,
    get: name => ({ fetch: () => new Response(name) }),
  } };
  const url = 'https://relay.example/__p2p-core/ws?room=' + encodeURIComponent(room);
  const request = origin => new Request(url, { headers: { Origin: origin, Upgrade: 'websocket' } });
  assert.equal((await worker.fetch(request('https://unknown.example'), env)).status, 403);
  assert.equal(await (await worker.fetch(request('https://another.example'), env)).text(), room);
  assert.equal((await worker.fetch(new Request(url), env)).status, 426);
});

test('relay forwards targeted messages, restores membership, and broadcasts departure', () => {
  const host = makeSocket(), guest = makeSocket(), other = makeSocket();
  const sockets = () => [host, guest, other];
  let protocol = new RelayRoomProtocol(sockets);
  for (const [id, socket] of Object.entries({ host, guest, other })) send(protocol, socket, { t: 'join', id, room });
  assert.deepEqual(guest.received[0], { t: 'peers', ids: ['host'] });
  assert.deepEqual(host.received[1], { t: 'join', id: 'guest' });
  protocol = new RelayRoomProtocol(sockets); // No in-memory membership survives hibernation.
  send(protocol, guest, { t: 'm', from: 'fake', to: ['host'], k: 'edit', d: { label: 'Updated' } });
  assert.deepEqual(host.received.at(-1), { t: 'm', from: 'guest', k: 'edit', d: { label: 'Updated' } });
  assert.equal(other.received.some(message => message.t === 'm'), false);
  send(protocol, guest, { t: 'bye' });
  protocol.leave(guest);
  assert.equal(host.received.filter(message => message.t === 'leave').length, 1);
  assert.deepEqual(other.received.at(-1), { t: 'leave', id: 'guest' });
});

test('connections cannot join a different room or send before joining', () => {
  const host = makeSocket(), outsider = makeSocket();
  const protocol = new RelayRoomProtocol(() => [host, outsider]);
  send(protocol, host, { t: 'join', id: 'host', room });
  send(protocol, outsider, { t: 'm', k: 'edit', d: 'ignored' });
  send(protocol, outsider, { t: 'join', id: 'outsider', room: 'another:room' });
  assert.equal(outsider.readyState, 3);
  assert.deepEqual(host.received, [{ t: 'peers', ids: [] }]);
});
