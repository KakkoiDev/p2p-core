/**
 * Ringing, server side: send Web Push messages (RFC 8030) so a phone or computer rings for a
 * call even when the app's page is closed. Encryption is RFC 8291 (aes128gcm), the server's
 * identity is VAPID (RFC 8292). Node built-ins only, no dependencies.
 *
 *   import { createPusher } from 'p2p-core/server/push';
 *   const pusher = createPusher({ privateKey: savedKey, subject: 'mailto:you@example.com' });
 *   pusher.publicKey                     // give this to the page (extras/ring.js `enable`)
 *   pusher.privateKey                    // save it: a new key orphans every subscription
 *   const r = await pusher.send(subscription, { kind: 'call', title: 'Ann is calling', url: '/call' });
 *   if (r.gone) forget(subscription);    // the browser unsubscribed or was reset
 *
 * The page sends you `subscription` (PushSubscription.toJSON()). Keep it per person and send
 * to each of their devices. A push is only worth a short time for a call: `ttl` is 60 s.
 *
 * Only real push services are accepted (Google, Mozilla, Apple, Microsoft): a subscription
 * names a URL your server will POST to, so anything else would let a page make your server
 * probe its own network.
 */
import { createECDH, createHmac, createCipheriv, createPrivateKey, createPublicKey, createSign, randomBytes } from 'node:crypto';

const b64 = (buf) => Buffer.from(buf).toString('base64url');
const unb64 = (s) => Buffer.from(String(s), 'base64url');

/** The push services a subscription may point at. */
export function allowedEndpoint(raw) {
  let u;
  try { u = new URL(raw); } catch { return false; }
  if (u.protocol !== 'https:' || u.username || u.password || u.port) return false;
  const h = u.hostname.toLowerCase();
  return h === 'fcm.googleapis.com' || h === 'updates.push.services.mozilla.com'
    || h.endsWith('.push.apple.com') || h.endsWith('.notify.windows.com');
}

/**
 * Why a subscription cannot be used, in words for the person, or '' when it can. Chromium
 * builds without Google's push keys (some privacy browsers) hand out placeholder addresses
 * such as https://permanently-removed.invalid/…: they install fine but can never ring.
 */
export function refusal(subscription) {
  const endpoint = subscription?.endpoint;
  let host = '';
  try { host = new URL(endpoint).hostname; } catch { /* not a URL */ }
  if (!host || host.endsWith('.invalid')) {
    return 'this browser has no push service, so it cannot ring. Use Chrome, Edge, Safari or Firefox';
  }
  if (!allowedEndpoint(endpoint)) return `this browser's push service (${host}) is not one this server sends to`;
  const p256dh = unb64(subscription?.keys?.p256dh || '');
  const auth = unb64(subscription?.keys?.auth || '');
  if (p256dh.length !== 65 || auth.length !== 16) return 'the subscription keys are malformed';
  return '';
}

function hkdf(salt, ikm, info, length) {
  const prk = createHmac('sha256', salt).update(ikm).digest();
  return createHmac('sha256', prk).update(Buffer.concat([Buffer.from(info), Buffer.from([1])])).digest().subarray(0, length);
}

/**
 * RFC 8291 encryption (one aes128gcm record). `ephemeral` (a 32-byte private key) and `salt`
 * are for tests; fresh random ones are used otherwise.
 */
export function encrypt(plaintext, uaPublic, authSecret, { ephemeral, salt } = {}) {
  const ecdh = createECDH('prime256v1');
  if (ephemeral) ecdh.setPrivateKey(Buffer.from(ephemeral));
  else ecdh.generateKeys();
  const asPublic = ecdh.getPublicKey();
  salt = salt ? Buffer.from(salt) : randomBytes(16);
  const shared = ecdh.computeSecret(Buffer.from(uaPublic));
  const ikm = hkdf(Buffer.from(authSecret), shared, Buffer.concat([Buffer.from('WebPush: info\0'), Buffer.from(uaPublic), asPublic]), 32);
  const cek = hkdf(salt, ikm, 'Content-Encoding: aes128gcm\0', 16);
  const nonce = hkdf(salt, ikm, 'Content-Encoding: nonce\0', 12);
  const cipher = createCipheriv('aes-128-gcm', cek, nonce);
  const body = Buffer.concat([cipher.update(Buffer.concat([Buffer.from(plaintext), Buffer.from([2])])), cipher.final(), cipher.getAuthTag()]);
  const header = Buffer.alloc(21);
  salt.copy(header, 0);
  header.writeUInt32BE(4096, 16);
  header[20] = asPublic.length;
  return Buffer.concat([header, asPublic, body]);
}

function keyPair(privateKey) {
  const ecdh = createECDH('prime256v1');
  if (privateKey) ecdh.setPrivateKey(unb64(privateKey));
  else ecdh.generateKeys();
  const pub = ecdh.getPublicKey();
  const jwk = { kty: 'EC', crv: 'P-256', d: b64(ecdh.getPrivateKey()), x: b64(pub.subarray(1, 33)), y: b64(pub.subarray(33, 65)) };
  return { privateKey: b64(ecdh.getPrivateKey()), publicKey: b64(pub), key: createPrivateKey({ key: jwk, format: 'jwk' }), jwk };
}

/** A VAPID token for the push service at `endpoint` (RFC 8292). */
export function vapidToken(endpoint, { key, subject, now = Date.now() }) {
  const u = new URL(endpoint);
  const signing = b64('{"typ":"JWT","alg":"ES256"}') + '.' + b64(JSON.stringify({ aud: u.origin, exp: Math.floor(now / 1000) + 12 * 3600, sub: subject }));
  const sig = createSign('SHA256').update(signing).sign({ key, dsaEncoding: 'ieee-p1363' });
  return signing + '.' + b64(sig);
}

/**
 * A sender. `privateKey` is the base64url key from an earlier `createPusher().privateKey`
 * (omit it once to make one, then save it). `subject` is a contact for the push services.
 * `fetch` and `allowEndpoint` are for tests.
 */
export function createPusher({ privateKey, subject = 'mailto:push@localhost', fetch: fetchFn = globalThis.fetch, allowEndpoint = allowedEndpoint } = {}) {
  const keys = keyPair(privateKey);
  return {
    publicKey: keys.publicKey,
    privateKey: keys.privateKey,
    /** The public key as a KeyObject, to verify tokens in tests. */
    verifyKey: createPublicKey({ key: { ...keys.jwk, d: undefined }, format: 'jwk' }),
    /**
     * Send `message` (any JSON) to one subscription. Resolves to { ok, gone, status, why }:
     * `gone` means the push service no longer knows this browser: forget the subscription.
     */
    async send(subscription, message, { ttl = 60, urgency = 'high' } = {}) {
      const why = allowEndpoint === allowedEndpoint ? refusal(subscription) : (allowEndpoint(subscription?.endpoint) ? '' : 'endpoint not allowed');
      if (why) return { ok: false, gone: true, status: 0, why };
      const body = encrypt(Buffer.from(JSON.stringify(message)), unb64(subscription.keys.p256dh), unb64(subscription.keys.auth));
      let res;
      try {
        res = await fetchFn(subscription.endpoint, {
          method: 'POST',
          body,
          headers: {
            'Content-Encoding': 'aes128gcm',
            'Content-Type': 'application/octet-stream',
            TTL: String(ttl),
            Urgency: urgency,
            Authorization: `vapid t=${vapidToken(subscription.endpoint, { key: keys.key, subject })}, k=${keys.publicKey}`,
          },
        });
      } catch (err) {
        return { ok: false, gone: false, status: 0, why: String(err?.message || err) };
      }
      if (res.status === 404 || res.status === 410) {
        return { ok: false, gone: true, status: res.status, why: 'the push service no longer knows this browser' };
      }
      if (res.status >= 300) return { ok: false, gone: false, status: res.status, why: `the push service answered ${res.status}` };
      return { ok: true, gone: false, status: res.status, why: '' };
    },
  };
}
