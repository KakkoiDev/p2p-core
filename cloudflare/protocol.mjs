const MAX_FRAME_BYTES = 384 * 1024;
const MAX_MESSAGES_PER_SECOND = 120;
const validId = id => typeof id === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(id);

export function validRoom(room) {
  return typeof room === 'string' && room.length <= 300 && room.includes(':') && !/[\u0000-\u001f\u007f]/.test(room);
}

export class RelayRoomProtocol {
  constructor(sockets) {
    this.sockets = sockets;
  }

  peers(socket) {
    return this.sockets().filter(peer => peer !== socket && peer.readyState === 1 && peer.deserializeAttachment()?.id);
  }

  send(socket, value) {
    try { socket.send(JSON.stringify(value)); } catch { /* The socket can close during delivery. */ }
  }

  leave(socket) {
    const peer = socket.deserializeAttachment();
    if (!peer?.id) return;
    socket.serializeAttachment({ ...peer, id: null });
    for (const other of this.peers(socket)) this.send(other, { t: 'leave', id: peer.id });
  }

  receive(socket, raw) {
    const state = socket.deserializeAttachment();
    if (!state || typeof raw !== 'string') return;
    if (raw.length > MAX_FRAME_BYTES || new TextEncoder().encode(raw).byteLength > MAX_FRAME_BYTES) {
      this.leave(socket);
      socket.close(1009, 'Message too large');
      return;
    }
    const second = Math.floor(Date.now() / 1000);
    state.count = second === state.second ? state.count + 1 : 1;
    state.second = second;
    if (state.count > MAX_MESSAGES_PER_SECOND) {
      this.leave(socket);
      socket.close(1008, 'Rate limit');
      return;
    }
    socket.serializeAttachment(state);
    let message;
    try { message = JSON.parse(raw); } catch { return; }
    if (!message || typeof message !== 'object') return;
    if (message.t === 'join' && !state.id) {
      if (message.room !== state.room || !validId(message.id)) {
        socket.close(1008, 'Invalid join');
        return;
      }
      const peers = this.peers(socket);
      const duplicate = peers.find(peer => peer.deserializeAttachment().id === message.id);
      if (duplicate) {
        const previous = duplicate.deserializeAttachment();
        duplicate.serializeAttachment({ ...previous, id: null });
        duplicate.close(4000, 'Replaced');
      }
      socket.serializeAttachment({ ...state, id: message.id });
      const others = peers.filter(peer => peer !== duplicate);
      this.send(socket, { t: 'peers', ids: others.map(peer => peer.deserializeAttachment().id) });
      for (const peer of others) this.send(peer, { t: 'join', id: message.id });
      return;
    }
    if (!state.id) return;
    if (message.t === 'bye') {
      this.leave(socket);
      socket.close(1000, 'Left room');
      return;
    }
    if (message.t !== 'm' || typeof message.k !== 'string' || message.k.length < 1 || message.k.length > 12) return;
    if (message.to != null && (!Array.isArray(message.to) || message.to.length > 16 || !message.to.every(validId))) return;
    const outgoing = { t: 'm', from: state.id, k: message.k, d: message.d };
    for (const peer of this.peers(socket)) {
      if (message.to == null || message.to.includes(peer.deserializeAttachment().id)) this.send(peer, outgoing);
    }
  }
}
