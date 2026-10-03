/**
 * A minimal WebSocket server (RFC 6455) on Node's http module, so the local
 * server needs no npm dependencies. It handles what browsers send: text and
 * binary frames, fragmentation, ping/pong and close. No extensions.
 */
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const MAX_MESSAGE = 4 * 1024 * 1024;

function frame(opcode, payload) {
  const length = payload.length;
  let header;
  if (length < 126) {
    header = Buffer.from([0x80 | opcode, length]);
  } else if (length < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(length), 2);
  }
  return Buffer.concat([header, payload]);
}

export class WebSocketConnection extends EventEmitter {
  constructor(socket, request) {
    super();
    this.socket = socket;
    this.request = request;
    this.buffer = Buffer.alloc(0);
    this.fragments = [];
    this.fragmentOpcode = 0;
    this.open = true;
    this.alive = true;
    socket.setNoDelay(true);
    socket.on('data', (chunk) => this.onData(chunk));
    socket.on('close', () => this.finish());
    socket.on('error', () => this.finish());
  }

  onData(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    for (;;) {
      if (this.buffer.length < 2) return;
      const first = this.buffer[0];
      const second = this.buffer[1];
      const fin = (first & 0x80) !== 0;
      const opcode = first & 0x0f;
      const masked = (second & 0x80) !== 0;
      let length = second & 0x7f;
      let offset = 2;
      if (length === 126) {
        if (this.buffer.length < 4) return;
        length = this.buffer.readUInt16BE(2);
        offset = 4;
      } else if (length === 127) {
        if (this.buffer.length < 10) return;
        const big = this.buffer.readBigUInt64BE(2);
        if (big > BigInt(MAX_MESSAGE)) { this.close(1009, 'message too big'); return; }
        length = Number(big);
        offset = 10;
      }
      if (length > MAX_MESSAGE) { this.close(1009, 'message too big'); return; }
      if (!masked) { this.close(1002, 'client frames must be masked'); return; }
      if (this.buffer.length < offset + 4 + length) return;
      const mask = this.buffer.subarray(offset, offset + 4);
      const payload = Buffer.from(this.buffer.subarray(offset + 4, offset + 4 + length));
      for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
      this.buffer = this.buffer.subarray(offset + 4 + length);
      this.onFrame(fin, opcode, payload);
      if (!this.open) return;
    }
  }

  onFrame(fin, opcode, payload) {
    if (opcode === 0x8) { this.close(1000); return; }
    if (opcode === 0x9) { this.write(frame(0xa, payload)); return; }
    if (opcode === 0xa) { this.alive = true; return; }
    if (opcode === 0x1 || opcode === 0x2) {
      this.fragmentOpcode = opcode;
      this.fragments = [payload];
    } else if (opcode === 0x0) {
      this.fragments.push(payload);
    } else {
      this.close(1002, 'unknown opcode');
      return;
    }
    const total = this.fragments.reduce((n, b) => n + b.length, 0);
    if (total > MAX_MESSAGE) { this.close(1009, 'message too big'); return; }
    if (!fin) return;
    const whole = Buffer.concat(this.fragments);
    this.fragments = [];
    this.emit('message', this.fragmentOpcode === 0x1 ? whole.toString('utf8') : whole);
  }

  write(data) {
    if (!this.open) return;
    try { this.socket.write(data); } catch { this.finish(); }
  }

  send(text) {
    this.write(frame(typeof text === 'string' ? 0x1 : 0x2, Buffer.from(text)));
  }

  ping() {
    this.write(frame(0x9, Buffer.alloc(0)));
  }

  close(code = 1000, reason = '') {
    if (!this.open) return;
    const payload = Buffer.alloc(2 + Buffer.byteLength(reason));
    payload.writeUInt16BE(code, 0);
    payload.write(reason, 2);
    this.write(frame(0x8, payload));
    this.socket.end();
    this.finish();
  }

  finish() {
    if (!this.open) return;
    this.open = false;
    this.socket.destroy();
    this.emit('close');
  }
}

/** Complete the HTTP upgrade handshake, or refuse it. Returns a connection or null. */
export function acceptUpgrade(request, socket) {
  const key = request.headers['sec-websocket-key'];
  if (!key || String(request.headers.upgrade).toLowerCase() !== 'websocket') {
    socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
    return null;
  }
  const accept = createHash('sha1').update(key + GUID).digest('base64');
  socket.write([
    'HTTP/1.1 101 Switching Protocols',
    'Upgrade: websocket',
    'Connection: Upgrade',
    `Sec-WebSocket-Accept: ${accept}`,
    '', '',
  ].join('\r\n'));
  return new WebSocketConnection(socket, request);
}
