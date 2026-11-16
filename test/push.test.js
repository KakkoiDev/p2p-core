import test from 'node:test';
import assert from 'node:assert/strict';
import { createECDH, createHmac, createDecipheriv, createVerify } from 'node:crypto';
import { encrypt, createPusher, allowedEndpoint, refusal } from '../server/push.js';

const d = (s) => Buffer.from(s, 'base64url');

test('push encryption matches the worked example of RFC 8291', () => {
  const out = encrypt(Buffer.from('When I grow up, I want to be a watermelon'),
    d('BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4'),
    d('BTBZMqHH6r4Tts7J_aSIgg'),
    { ephemeral: d('yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw'), salt: d('DGv6ra1nlYgDCS1FRnbzlw') });
  assert.equal(out.toString('base64url'),
    'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN');
});

test('the VAPID token is signed by the pusher, for the push service origin', () => {
  const pusher = createPusher({ subject: 'mailto:test@example.com' });
  const again = createPusher({ privateKey: pusher.privateKey, subject: 'mailto:test@example.com' });
  assert.equal(again.publicKey, pusher.publicKey, 'a saved key gives the same identity');
  const fake = { endpoint: 'https://fcm.googleapis.com/fcm/send/abc' };
  let token;
  const seen = createPusher({
    privateKey: pusher.privateKey, subject: 'mailto:test@example.com', allowEndpoint: () => true,
    fetch: async (_url, init) => { token = init.headers.Authorization; return { status: 201 }; },
  });
  return seen.send({ ...fake, keys: browserKeys().keys }, { hi: 1 }).then((r) => {
    assert.equal(r.ok, true);
    const [, t, k] = token.match(/^vapid t=([^,]+), k=(.+)$/);
    assert.equal(k, pusher.publicKey);
    const [h, c, s] = t.split('.');
    const claims = JSON.parse(d(c).toString());
    assert.equal(claims.aud, 'https://fcm.googleapis.com');
    assert.equal(claims.sub, 'mailto:test@example.com');
    assert.ok(createVerify('SHA256').update(h + '.' + c).verify({ key: pusher.verifyKey, dsaEncoding: 'ieee-p1363' }, d(s)));
  });
});

// A browser's side of a subscription, to decrypt what the server sent.
function browserKeys() {
  const ecdh = createECDH('prime256v1');
  ecdh.generateKeys();
  const auth = Buffer.from('0123456789abcdef');
  return { ecdh, auth, keys: { p256dh: ecdh.getPublicKey().toString('base64url'), auth: auth.toString('base64url') } };
}
function decrypt(body, browser) {
  const salt = body.subarray(0, 16);
  const idlen = body[20];
  const asPublic = body.subarray(21, 21 + idlen);
  const shared = browser.ecdh.computeSecret(asPublic);
  const hk = (s, ikm, info, n) => createHmac('sha256', createHmac('sha256', s).update(ikm).digest()).update(Buffer.concat([Buffer.from(info), Buffer.from([1])])).digest().subarray(0, n);
  const ikm = hk(browser.auth, shared, Buffer.concat([Buffer.from('WebPush: info\0'), browser.ecdh.getPublicKey(), asPublic]), 32);
  const cek = hk(salt, ikm, 'Content-Encoding: aes128gcm\0', 16);
  const nonce = hk(salt, ikm, 'Content-Encoding: nonce\0', 12);
  const sealed = body.subarray(21 + idlen);
  const dec = createDecipheriv('aes-128-gcm', cek, nonce);
  dec.setAuthTag(sealed.subarray(sealed.length - 16));
  const plain = Buffer.concat([dec.update(sealed.subarray(0, sealed.length - 16)), dec.final()]);
  assert.equal(plain[plain.length - 1], 2, 'last record delimiter');
  return JSON.parse(plain.subarray(0, -1).toString());
}

test('send: the browser can decrypt the message; headers ask for a short, urgent delivery', async () => {
  const browser = browserKeys();
  let seen;
  const pusher = createPusher({
    subject: 'https://example.com', allowEndpoint: () => true,
    fetch: async (url, init) => { seen = { url, init }; return { status: 201 }; },
  });
  const r = await pusher.send({ endpoint: 'https://fcm.googleapis.com/fcm/send/x', keys: browser.keys }, { kind: 'call', title: 'Ann is calling' });
  assert.deepEqual(r, { ok: true, gone: false, status: 201, why: '' });
  assert.equal(seen.init.headers['Content-Encoding'], 'aes128gcm');
  assert.equal(seen.init.headers.TTL, '60');
  assert.equal(seen.init.headers.Urgency, 'high');
  assert.deepEqual(decrypt(seen.init.body, browser), { kind: 'call', title: 'Ann is calling' });
});

test('send: a gone subscription is reported so the app forgets it', async () => {
  const pusher = createPusher({ subject: 'https://example.com', allowEndpoint: () => true, fetch: async () => ({ status: 410 }) });
  const r = await pusher.send({ endpoint: 'https://fcm.googleapis.com/x', keys: browserKeys().keys }, {});
  assert.equal(r.gone, true);
  assert.equal(r.ok, false);
});

test('only real push services are accepted, and refusals say why', async () => {
  for (const [url, ok] of Object.entries({
    'https://fcm.googleapis.com/fcm/send/x': true,
    'https://updates.push.services.mozilla.com/wpush/': true,
    'https://web.push.apple.com/abc': true,
    'https://wns2-par02p.notify.windows.com/w/?token=x': true,
    'http://fcm.googleapis.com/x': false,
    'https://127.0.0.1/x': false,
    'https://fcm.googleapis.com:8443/x': false,
    'https://evil.example/fcm.googleapis.com': false,
    'https://user@fcm.googleapis.com/x': false,
  })) assert.equal(allowedEndpoint(url), ok, url);
  const keys = browserKeys().keys;
  assert.match(refusal({ endpoint: 'https://permanently-removed.invalid/fcm/send/x', keys }), /no push service/);
  assert.match(refusal({ endpoint: 'https://push.example.net/x', keys }), /push\.example\.net/);
  assert.match(refusal({ endpoint: 'https://fcm.googleapis.com/x', keys: { p256dh: 'x', auth: 'y' } }), /malformed/);
  assert.equal(refusal({ endpoint: 'https://fcm.googleapis.com/x', keys }), '');
  // The real sender never posts to a refused address.
  let posted = false;
  const pusher = createPusher({ subject: 'https://example.com', fetch: async () => { posted = true; return { status: 201 }; } });
  const r = await pusher.send({ endpoint: 'https://127.0.0.1/x', keys }, {});
  assert.equal(posted, false);
  assert.equal(r.ok, false);
});

test('a placeholder contact is refused up front (Apple answers BadJwtToken to it)', () => {
  assert.throws(() => createPusher({ subject: 'mailto:push@localhost' }), /real contact/);
  assert.throws(() => createPusher({}), /real contact/);
  assert.ok(createPusher({ subject: 'https://example.com' }).publicKey);
});
