import test from 'node:test';
import assert from 'node:assert/strict';
import { ringing, installer, keyBytes, platform, advice } from '../extras/ring.js';

// A stand-in browser: storage, notifications, a service worker and its push manager.
function fakeBrowser({ permission = 'granted', grant = 'granted', brands = [{ brand: 'Google Chrome' }], subscribeFails = false } = {}) {
  const store = new Map();
  const state = { subscribed: null, unsubscribed: 0, asked: 0 };
  const sub = { endpoint: 'https://fcm.googleapis.com/fcm/send/x', toJSON: () => ({ endpoint: sub.endpoint, keys: { p256dh: 'p', auth: 'a' } }), unsubscribe: async () => { state.unsubscribed++; state.subscribed = null; } };
  globalThis.localStorage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, String(v)) };
  globalThis.PushManager = function PushManager() {};
  globalThis.Notification = { permission, requestPermission: async () => { state.asked++; return grant; } };
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: {
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', userAgentData: { brands },
    serviceWorker: { ready: Promise.resolve({ pushManager: {
      getSubscription: async () => state.subscribed,
      subscribe: async () => { if (subscribeFails) throw new Error('push service error'); state.subscribed = sub; return sub; },
    } }) },
  } });
  return state;
}

const server = (probeAnswer) => {
  const calls = [];
  return {
    calls,
    publicKey: 'BEl62iUYgUivxIkv69yViEuiBIa-Ib9-SkvMeAtA3LFgDzkrxZJjSgSnfckjBJuBkr3qBUYIHBQFLXYp5Nksh8U',
    save: async (s) => calls.push(['save', s.endpoint]),
    forget: async (s) => calls.push(['forget', s.endpoint]),
    probe: async (s) => { calls.push(['probe', s.endpoint]); if (probeAnswer instanceof Error) throw probeAnswer; return probeAnswer; },
  };
};

test('enable: subscribes, saves, probes for real, and remembers that this browser can ring', async () => {
  const b = fakeBrowser();
  const s = server({ ok: true });
  const ring = ringing(s);
  assert.equal(ring.capability(), '');
  assert.equal(ring.likely(), false, 'a branded Chromium is not trusted before the probe');
  assert.deepEqual(await ring.enable(), { ok: true, why: '' });
  assert.deepEqual(s.calls.map((c) => c[0]), ['save', 'probe']);
  assert.equal(ring.capability(), 'yes');
  assert.equal(ring.likely(), true);
  assert.equal(await ring.enabled(), true);
  assert.equal(b.unsubscribed, 0);
});

test('enable: a push that never arrives marks the browser as unable to ring, and undoes the subscription', async () => {
  const b = fakeBrowser();
  const s = server({ ok: false, why: 'the push service no longer knows this browser' });
  const ring = ringing(s);
  const r = await ring.enable();
  assert.equal(r.ok, false);
  assert.match(r.why, /no longer knows/);
  assert.equal(ring.capability(), 'no');
  assert.equal(ring.likely(), false);
  assert.equal(b.unsubscribed, 1);
  assert.deepEqual(s.calls.map((c) => c[0]), ['save', 'probe', 'forget']);
});

test('enable: a server error says nothing about the browser; a refused permission is not remembered', async () => {
  fakeBrowser();
  const failing = ringing(server(new Error('network down')));
  assert.equal((await failing.enable()).ok, false);
  assert.equal(failing.capability(), '', 'our own server failing must not brand the browser');
  const b = fakeBrowser({ permission: 'default', grant: 'denied' });
  const ring = ringing(server({ ok: true }));
  assert.match((await ring.enable()).why, /not allowed/);
  assert.equal(b.asked, 1);
  assert.equal(ring.capability(), '');
  fakeBrowser({ subscribeFails: true });
  const broken = ringing(server({ ok: true }));
  assert.equal((await broken.enable()).ok, false);
  assert.equal(broken.capability(), 'no', 'a browser that cannot even subscribe cannot ring');
});

test('Safari and Firefox (no brand list) are trusted before any probe', () => {
  fakeBrowser({ brands: [] });
  assert.equal(ringing(server({ ok: true })).likely(), true);
});

test('installer: recommends installing only where ringing works', async () => {
  fakeBrowser();
  const ring = ringing(server({ ok: true }));
  const handlers = {};
  const win = { addEventListener: (k, fn) => { handlers[k] = fn; }, removeEventListener() {}, matchMedia: () => ({ matches: false }), navigator: globalThis.navigator };
  const inst = installer({ ring, win });
  let changes = 0;
  inst.onChange(() => changes++);
  assert.equal(inst.available, false);
  let prompted = 0;
  handlers.beforeinstallprompt({ preventDefault() {}, prompt() { prompted++; }, userChoice: Promise.resolve({ outcome: 'accepted' }) });
  assert.equal(changes, 1);
  assert.equal(inst.available, true);
  assert.equal(inst.recommended, false, 'not before the probe on a branded Chromium');
  await ring.enable();
  inst.refresh();
  assert.equal(inst.recommended, true);
  assert.equal(await inst.prompt(), 'accepted');
  assert.equal(prompted, 1);
  assert.equal(inst.available, false, 'the prompt can be shown once');
  assert.equal(await inst.prompt(), 'unavailable');
});

test('helpers: key bytes, platform and advice', () => {
  assert.equal(keyBytes('AQID').length, 3);
  assert.deepEqual([...keyBytes('AQID')], [1, 2, 3]);
  assert.equal(platform({ userAgent: 'Mozilla/5.0 (Linux; Android 14)' }), 'android');
  assert.equal(platform({ userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)' }), 'ios');
  assert.equal(platform({ userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', maxTouchPoints: 5 }), 'ios');
  assert.equal(platform({ userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', maxTouchPoints: 0 }), 'mac');
  assert.equal(platform({ userAgent: 'Mozilla/5.0 (Windows NT 10.0)' }), 'desktop');
  assert.match(advice('mac'), /Safari/);
});
