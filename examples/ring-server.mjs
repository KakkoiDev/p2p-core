// The ringing example's server: serves this repository and keeps push subscriptions in memory.
//
//   node examples/ring-server.mjs        then open http://localhost:8788/examples/ring.html
//
// localhost counts as a secure origin, so push works without HTTPS here. A real app keeps
// the private key (pusher.privateKey) and the subscriptions on disk, per person.
import { createServer } from 'node:http';
import { createReadStream, promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPusher, refusal } from '../server/push.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css' };
const pusher = createPusher({ subject: 'https://example.com' }); // use your own site or mailto: address
const subs = new Map(); // endpoint -> subscription

async function body(req) {
  let s = '';
  for await (const chunk of req) { s += chunk; if (s.length > 8192) throw new Error('too big'); }
  return JSON.parse(s || '{}');
}
const json = (res, status, data) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(data)); };

createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  try {
    if (req.method === 'GET' && url.pathname === '/push/key') return json(res, 200, { key: pusher.publicKey });
    if (req.method === 'POST' && url.pathname.startsWith('/push/')) {
      const sub = await body(req);
      const action = url.pathname.slice(6);
      if (action === 'subscribe') {
        const why = refusal(sub);
        if (why) return json(res, 400, { error: why });
        subs.set(sub.endpoint, sub);
        return json(res, 200, { ok: true });
      }
      if (action === 'unsubscribe') { subs.delete(sub.endpoint); return json(res, 200, { ok: true }); }
      if (action === 'probe') {
        const r = await pusher.send(sub, { kind: 'test', title: 'This browser can ring', body: 'Calls will show up like this.', url: '/examples/ring.html' });
        if (r.gone) subs.delete(sub.endpoint);
        return json(res, 200, { ok: r.ok, why: r.why });
      }
      if (action === 'ring') { // ring every subscribed browser, as a call would
        const results = [];
        for (const s of subs.values()) {
          const r = await pusher.send(s, { kind: 'call', title: 'Someone is calling', body: 'Tap to join.', url: '/examples/ring.html', tag: 'call' });
          if (r.gone) subs.delete(s.endpoint);
          results.push(r);
        }
        return json(res, 200, { rang: results.filter((r) => r.ok).length, of: results.length });
      }
    }
    const file = path.join(ROOT, path.normalize(decodeURIComponent(url.pathname)));
    if (!file.startsWith(ROOT + path.sep)) { res.writeHead(404); return res.end(); }
    if (!(await fs.stat(file)).isFile()) throw new Error('not a file');
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    createReadStream(file).on('error', () => res.destroy()).pipe(res);
  } catch {
    res.writeHead(404); res.end('not found');
  }
}).listen(8788, '127.0.0.1', () => console.log('Ringing example: http://localhost:8788/examples/ring.html'));
