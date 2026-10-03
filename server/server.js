/**
 * The local server: serves a game's files and passes messages between the
 * devices that opened it. For a classroom or a LAN party with no internet.
 *
 *   npx p2p-core serve ./my-game          (or: node server/server.js ./my-game)
 *
 * Everyone opens the address it prints (or scans the QR code it prints). A game
 * using joinRoom() in mode 'auto' or 'offline' notices it was served from here
 * and connects to it without any configuration.
 *
 * Programmatic use:
 *   import { startServer } from 'p2p-core/server';
 *   const server = await startServer({ root: './my-game', port: 8787 });
 *   server.close();
 */
import { createServer } from 'node:http';
import { createReadStream, promises as fs } from 'node:fs';
import { networkInterfaces } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { acceptUpgrade } from './ws.js';

const PATH = '/__p2p-core';
const HERE = path.dirname(fileURLToPath(import.meta.url));
const LIB_ROOT = path.resolve(HERE, '..');

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.wav': 'audio/wav',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.wasm': 'application/wasm',
};

/** The addresses other devices on the network can reach this machine at. */
export function lanAddresses() {
  const out = [];
  for (const list of Object.values(networkInterfaces())) {
    for (const item of list || []) {
      if (item.family === 'IPv4' && !item.internal) out.push(item.address);
    }
  }
  return out;
}

export async function startServer({
  root = process.cwd(),
  port = 8787,
  host = '0.0.0.0',
  log = console.log,
  version = '0.0.0',
  maxPeersPerRoom = 200,
} = {}) {
  const base = path.resolve(root);
  /** room key -> Map(peerId -> client) */
  const rooms = new Map();
  const clients = new Set();

  async function serveFile(request, response) {
    let pathname;
    try {
      pathname = decodeURIComponent(new URL(request.url, 'http://x').pathname);
    } catch {
      response.writeHead(400).end();
      return;
    }
    // The library itself is served too, so a page on this server can import
    // /__p2p-core/lib/p2p-core.js without copying anything.
    let file;
    if (pathname.startsWith(`${PATH}/lib/`)) {
      file = path.join(LIB_ROOT, pathname.slice(`${PATH}/lib/`.length));
      if (!file.startsWith(LIB_ROOT + path.sep)) { response.writeHead(403).end(); return; }
    } else {
      file = path.join(base, pathname);
      if (file !== base && !file.startsWith(base + path.sep)) { response.writeHead(403).end(); return; }
    }
    try {
      let stat = await fs.stat(file);
      if (stat.isDirectory()) {
        if (!pathname.endsWith('/')) {
          response.writeHead(301, { Location: `${pathname}/` }).end();
          return;
        }
        file = path.join(file, 'index.html');
        stat = await fs.stat(file);
      }
      response.writeHead(200, {
        'Content-Type': TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream',
        'Content-Length': stat.size,
        'Cache-Control': 'no-cache',
      });
      if (request.method === 'HEAD') { response.end(); return; }
      createReadStream(file).pipe(response);
    } catch {
      response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Not found');
    }
  }

  const server = createServer((request, response) => {
    if (request.url.startsWith(`${PATH}/info`)) {
      response.writeHead(200, {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store',
        'Access-Control-Allow-Origin': '*',
      });
      response.end(JSON.stringify({ p2pCore: true, version, rooms: rooms.size, clients: clients.size }));
      return;
    }
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      response.writeHead(405).end();
      return;
    }
    serveFile(request, response);
  });

  function leave(client) {
    if (!client.room) return;
    const room = rooms.get(client.room);
    if (room?.get(client.id) === client) {
      room.delete(client.id);
      const note = JSON.stringify({ t: 'leave', id: client.id });
      for (const other of room.values()) other.ws.send(note);
      if (!room.size) rooms.delete(client.room);
    }
    client.room = null;
  }

  server.on('upgrade', (request, socket) => {
    if (!request.url.startsWith(`${PATH}/ws`)) {
      socket.end('HTTP/1.1 404 Not Found\r\n\r\n');
      return;
    }
    const ws = acceptUpgrade(request, socket);
    if (!ws) return;
    const client = { ws, id: null, room: null };
    clients.add(client);

    ws.on('message', (text) => {
      if (typeof text !== 'string') return;
      let msg;
      try { msg = JSON.parse(text); } catch { return; }
      if (!msg || typeof msg !== 'object') return;

      if (msg.t === 'join') {
        if (typeof msg.room !== 'string' || typeof msg.id !== 'string' || msg.room.length > 300 || msg.id.length > 64) {
          ws.send(JSON.stringify({ t: 'error', message: 'bad join' }));
          return;
        }
        leave(client);
        if (!rooms.has(msg.room)) rooms.set(msg.room, new Map());
        const room = rooms.get(msg.room);
        if (room.size >= maxPeersPerRoom) {
          ws.send(JSON.stringify({ t: 'error', message: 'this room is full' }));
          return;
        }
        // The same id reconnecting (a page that lost its socket) replaces its
        // old connection rather than appearing twice.
        const old = room.get(msg.id);
        if (old) { old.room = null; old.ws.close(4000, 'replaced'); }
        client.id = msg.id;
        client.room = msg.room;
        ws.send(JSON.stringify({ t: 'peers', ids: [...room.keys()] }));
        const note = JSON.stringify({ t: 'join', id: client.id });
        for (const other of room.values()) other.ws.send(note);
        room.set(client.id, client);
        return;
      }

      if (msg.t === 'm' && client.room && typeof msg.k === 'string') {
        const room = rooms.get(client.room);
        if (!room) return;
        const out = JSON.stringify({ t: 'm', from: client.id, k: msg.k, d: msg.d });
        const to = Array.isArray(msg.to) ? msg.to : null;
        if (to) {
          for (const id of to) if (id !== client.id) room.get(id)?.ws.send(out);
        } else {
          for (const [id, other] of room) if (id !== client.id) other.ws.send(out);
        }
        return;
      }

      if (msg.t === 'bye') leave(client);
    });

    ws.on('close', () => {
      leave(client);
      clients.delete(client);
    });
  });

  // A phone that walked out of Wi-Fi range never says goodbye. Ping everyone;
  // whoever has not answered by the next round is gone.
  const heartbeat = setInterval(() => {
    for (const client of clients) {
      if (!client.ws.alive) { client.ws.finish(); continue; }
      client.ws.alive = false;
      client.ws.ping();
    }
  }, 15000);
  heartbeat.unref?.();

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => { server.off('error', reject); resolve(); });
  });
  const actualPort = server.address().port;
  const urls = [`http://localhost:${actualPort}/`, ...lanAddresses().map((ip) => `http://${ip}:${actualPort}/`)];
  log?.(`p2p-core server — serving ${base}`);
  return {
    port: actualPort,
    urls,
    rooms,
    close() {
      clearInterval(heartbeat);
      for (const client of clients) client.ws.close(1001, 'server closing');
      return new Promise((resolve) => server.close(() => resolve()));
    },
  };
}
