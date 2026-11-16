/**
 * Ringing: let people be called while the app's page is closed (Web Push), and install the
 * app only where it can actually ring.
 *
 *   import { ringing, installer } from './vendor/p2p-core/extras/ring.js';
 *   const ring = ringing({
 *     publicKey,                                      // server/push.js createPusher().publicKey
 *     save: (sub) => post('/push/subscribe', sub),    // keep it on your server, per person
 *     forget: (sub) => post('/push/unsubscribe', sub),
 *     probe: (sub) => post('/push/probe', sub),       // server: pusher.send(sub, test note) → { ok, why }
 *   });
 *   const { ok, why } = await ring.enable();          // asks permission, subscribes, checks for real
 *   const install = installer({ ring });
 *   install.onChange(() => button.hidden = !install.recommended);
 *   button.onclick = () => install.prompt();
 *
 * Your service worker shows the notifications: `importScripts('…/extras/ring-sw.js')`.
 *
 * Probe, don't guess. Some Chromium builds report themselves exactly as Google Chrome (same
 * brands, user agent and vendor) yet their push addresses are never delivered: the app
 * installs, notifications look "on", and nothing ever rings. The only reliable test is to
 * push one real message to the browser through your server, which `enable()` does via
 * `probe`. The answer is remembered on that browser ('yes' / 'no'). Safari and Firefox (no
 * `userAgentData.brands`) have working push.
 */

const MEMORY = 'p2p-core-ring';

function remember(value) { try { localStorage.setItem(MEMORY, value); } catch { /* storage off */ } }
function recalled() { try { return localStorage.getItem(MEMORY) || ''; } catch { return ''; } }

/** 'android' | 'ios' | 'mac' | 'desktop', for choosing which install steps to show. */
export function platform(nav = globalThis.navigator) {
  const ua = nav?.userAgent || '';
  if (/android/i.test(ua)) return 'android';
  if (/iphone|ipad|ipod/i.test(ua) || (/macintosh/i.test(ua) && nav.maxTouchPoints > 1)) return 'ios';
  if (/macintosh/i.test(ua)) return 'mac';
  return 'desktop';
}

/** What to use instead when this browser cannot ring, in words for the person. */
export function advice(where = platform()) {
  if (where === 'mac') return 'On a Mac, install from Safari (File → Add to Dock), Chrome or Edge to get calls.';
  if (where === 'ios') return 'On iPhone and iPad, open it in Safari, then Share → Add to Home Screen.';
  if (where === 'android') return 'On Android, install it from Chrome.';
  return 'Install it from Chrome, Edge or Firefox to get calls.';
}

/** Turn a base64url VAPID public key into what pushManager.subscribe wants. */
export function keyBytes(b64) {
  const s = atob(String(b64).replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - String(b64).length % 4) % 4));
  return Uint8Array.from(s, (ch) => ch.charCodeAt(0));
}

/** Running as the installed app (or inside a native wrapper)? */
export function runningInstalled(win = globalThis) {
  return !!(win.matchMedia?.('(display-mode: standalone)').matches || win.navigator?.standalone === true
    || win.Capacitor?.isNativePlatform?.());
}

export function ringing({ publicKey, save, forget, probe, workerReady } = {}) {
  if (!publicKey || typeof save !== 'function' || typeof probe !== 'function') {
    throw new Error('p2p-core ring: pass publicKey, save(sub) and probe(sub)');
  }
  const nav = globalThis.navigator;
  const ready = () => (workerReady ? workerReady() : nav.serviceWorker.ready);
  const supported = () => !!(nav?.serviceWorker && globalThis.PushManager && globalThis.Notification);
  const brandless = () => !(nav?.userAgentData?.brands || []).length;

  const api = {
    supported,
    /** 'yes' or 'no' once probed on this browser, '' before. */
    capability: () => recalled(),
    /** Ringing probably works: probed yes, or not probed yet on a browser without brand list (Safari, Firefox). */
    likely: () => recalled() === 'yes' || (recalled() === '' && brandless()),
    /** The current subscription, or null. */
    async subscription() {
      if (!supported()) return null;
      return (await ready()).pushManager.getSubscription();
    },
    /** Is this browser registered for ringing (subscribed here)? */
    async enabled() { return !!(await api.subscription()); },
    /**
     * Ask permission, subscribe, save on the server and push one real test through it.
     * Resolves to { ok, why }. On failure the subscription is removed again.
     */
    async enable() {
      if (!supported()) { remember('no'); return { ok: false, why: 'this browser cannot receive notifications here' }; }
      if (Notification.permission !== 'granted' && await Notification.requestPermission() !== 'granted') {
        return { ok: false, why: 'notifications were not allowed' }; // not remembered: the person may allow later
      }
      const json = (s) => (s.toJSON ? s.toJSON() : s);
      const undo = async (sub) => { try { await forget?.(json(sub)); await sub.unsubscribe(); } catch { /* already gone */ } };
      let sub;
      try {
        const reg = await ready();
        sub = await reg.pushManager.getSubscription()
          || await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(publicKey) });
      } catch (err) { // the browser could not subscribe at all: it cannot ring
        remember('no');
        return { ok: false, why: String(err?.message || err) };
      }
      let out;
      try {
        await save(json(sub));
        out = (await probe(json(sub))) || {};
      } catch (err) { // our server or the network failed: says nothing about the browser
        await undo(sub);
        return { ok: false, why: String(err?.message || err) };
      }
      if (!out.ok) { // the push service did not deliver: this browser cannot ring
        remember('no');
        await undo(sub);
        return { ok: false, why: out.why || 'the test push was not delivered' };
      }
      remember('yes');
      return { ok: true, why: '' };
    },
    /** Stop ringing on this browser. */
    async disable() {
      const sub = await api.subscription();
      if (!sub) return;
      try { await forget?.(sub.toJSON ? sub.toJSON() : sub); } finally { await sub.unsubscribe(); }
    },
  };
  return api;
}

/**
 * The browser's install prompt (Chrome, Edge, Android), offered only where ringing works.
 * `recommended` is true when the browser can install the app *and* ring there; when it can
 * install but not ring, show `advice()` and maybe an "install anyway" button.
 * Create it early (at page start): browsers fire the prompt event once, soon after load.
 */
export function installer({ ring, win = globalThis } = {}) {
  let deferred = null;
  const listeners = new Set();
  const changed = () => listeners.forEach((fn) => { try { fn(api); } catch { /* a listener's own problem */ } });
  const onPrompt = (e) => { e.preventDefault(); deferred = e; changed(); };
  const onInstalled = () => { deferred = null; changed(); };
  win.addEventListener?.('beforeinstallprompt', onPrompt);
  win.addEventListener?.('appinstalled', onInstalled);
  const api = {
    get available() { return !!deferred && !runningInstalled(win); },
    get installed() { return runningInstalled(win); },
    get recommended() { return api.available && (!ring || ring.likely()); },
    onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    /** Show the browser's install dialog. Resolves to 'accepted', 'dismissed' or 'unavailable'. */
    async prompt() {
      if (!deferred) return 'unavailable';
      const e = deferred;
      deferred = null;
      e.prompt();
      const choice = await e.userChoice.catch(() => ({ outcome: 'dismissed' }));
      changed();
      return choice?.outcome || 'dismissed';
    },
    /** Tell the installer that the ring probe ran (refresh `recommended`). */
    refresh: changed,
    stop() { win.removeEventListener?.('beforeinstallprompt', onPrompt); win.removeEventListener?.('appinstalled', onInstalled); listeners.clear(); },
  };
  return api;
}
