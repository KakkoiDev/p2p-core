import assert from 'node:assert/strict';
import test from 'node:test';
import { serverTransport } from '../src/transports/server.js';

test('room-in-URL routing is opt-in and reuses the join frame room key', async () => {
  const key = 'demo:room&key';
  for (const roomInUrl of [false, true]) {
    let socket;
    class WebSocketImpl {
      constructor(url) { this.url = new URL(url); socket = this; }
      send(message) { this.message = JSON.parse(message); }
      close() {}
    }
    const transport = serverTransport({ url: 'wss://relay.example', roomInUrl, WebSocketImpl });
    await transport.start({ key, selfId: 'peer', statusChanged() {} });
    try {
      socket.onopen();
      assert.equal(socket.url.pathname, '/__p2p-core/ws');
      assert.equal(socket.url.searchParams.get('room'), roomInUrl ? key : null);
      assert.deepEqual(socket.message, { t: 'join', room: key, id: 'peer' });
      assert.equal(new URL(transport.status().url).searchParams.has('room'), false);
    } finally {
      transport.stop();
    }
  }
});
