/**
 * A tiny in-memory nostr relay (NIP-01: EVENT, REQ, CLOSE) for the browser
 * tests, so trystero's real signalling runs end to end without the internet.
 * It does not check signatures; it is a test fixture, not a relay.
 */
import { createServer } from 'node:http';
import { acceptUpgrade } from '../server/ws.js';

function matches(filter, event) {
  if (filter.kinds && !filter.kinds.includes(event.kind)) return false;
  if (filter.since && event.created_at < filter.since) return false;
  for (const [key, values] of Object.entries(filter)) {
    if (!key.startsWith('#')) continue;
    const tag = key.slice(1);
    if (!event.tags.some((t) => t[0] === tag && values.includes(t[1]))) return false;
  }
  return true;
}

export async function startNostrRelay() {
  const subs = new Map(); // ws -> Map(subId -> filter)
  const server = createServer((req, res) => res.writeHead(426).end());
  server.on('upgrade', (request, socket) => {
    const ws = acceptUpgrade(request, socket);
    if (!ws) return;
    subs.set(ws, new Map());
    ws.on('message', (text) => {
      let msg;
      try { msg = JSON.parse(text); } catch { return; }
      if (msg[0] === 'REQ') {
        subs.get(ws).set(msg[1], msg[2] || {});
        ws.send(JSON.stringify(['EOSE', msg[1]]));
      } else if (msg[0] === 'CLOSE') {
        subs.get(ws).delete(msg[1]);
      } else if (msg[0] === 'EVENT') {
        const event = msg[1];
        ws.send(JSON.stringify(['OK', event.id, true, '']));
        for (const [other, list] of subs) {
          for (const [subId, filter] of list) {
            if (matches(filter, event)) other.send(JSON.stringify(['EVENT', subId, event]));
          }
        }
      }
    });
    ws.on('close', () => subs.delete(ws));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `ws://127.0.0.1:${server.address().port}`,
    close: () => { for (const ws of subs.keys()) ws.finish(); return new Promise((r) => server.close(r)); },
  };
}
