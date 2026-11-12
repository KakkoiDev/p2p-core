import { RelayRoomProtocol, validRoom } from './protocol.mjs';

export default {
  fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname !== '/__p2p-core/ws') return new Response('Not found', { status: 404 });
    if (request.method !== 'GET' || request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
      return new Response('WebSocket upgrade required', { status: 426 });
    }
    const origins = (env.ALLOWED_ORIGINS || '').split(',').map(origin => origin.trim());
    const origin = request.headers.get('Origin');
    if (!origin || !origins.includes(origin)) return new Response('Origin denied', { status: 403 });
    const room = url.searchParams.get('room');
    if (!validRoom(room)) return new Response('Invalid room', { status: 400 });
    return env.ROOMS.get(env.ROOMS.idFromName(room)).fetch(request);
  },
};

export class RelayRoom {
  constructor(ctx) {
    this.ctx = ctx;
    this.protocol = new RelayRoomProtocol(() => ctx.getWebSockets());
  }

  fetch(request) {
    if (this.ctx.getWebSockets().length >= 16) return new Response('Room is full', { status: 429 });
    const [client, server] = Object.values(new WebSocketPair());
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ room: new URL(request.url).searchParams.get('room'), id: null, count: 0, second: 0 });
    return new Response(null, { status: 101, webSocket: client });
  }

  webSocketMessage(socket, message) { this.protocol.receive(socket, message); }
  webSocketClose(socket) { this.protocol.leave(socket); }
  webSocketError(socket) {
    this.protocol.leave(socket);
    socket.close(1011, 'Socket error');
  }
}
