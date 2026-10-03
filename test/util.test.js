import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  sha256, encodeJson, decodeJson, packCode, unpackCode, isLocalAddress, payloadSize, randomId,
} from '../src/util.js';
import { classifyCandidates } from '../src/route.js';

test('sha256 matches node:crypto, including multi-block and unicode input', () => {
  for (const text of ['', 'abc', 'x'.repeat(55), 'x'.repeat(56), 'x'.repeat(200), 'chess ♞ 日本語']) {
    assert.equal(sha256(text), createHash('sha256').update(text, 'utf8').digest('hex'), JSON.stringify(text));
  }
});

test('binary payloads survive the JSON transports as Uint8Array', () => {
  const back = decodeJson(encodeJson({ a: new Uint8Array([0, 255, 7]), b: [new Uint16Array([513]).buffer], c: 'x' }));
  assert.deepEqual([...back.a], [0, 255, 7]);
  assert.deepEqual([...back.b[0]], [1, 2]);
  assert.equal(back.c, 'x');
});

test('pairing codes round-trip, compressed and plain, and refuse junk', async () => {
  const sdp = 'v=0\r\no=- 123 2 IN IP4 127.0.0.1\r\n'.repeat(20);
  const code = await packCode(sdp);
  assert.match(code, /^Z[A-Za-z0-9_-]+$/);
  assert.ok(code.length < sdp.length / 2, 'compression should help');
  assert.equal(await unpackCode(code), sdp);
  assert.equal(await unpackCode(`  ${code.slice(0, 10)}\n${code.slice(10)}  `), sdp, 'whitespace from a paste is ignored');
  assert.equal(await unpackCode('P' + Buffer.from('hello').toString('base64url')), 'hello');
  await assert.rejects(unpackCode('hello world'));
});

test('local addresses are recognised; public and carrier-NAT ones are not', () => {
  for (const a of ['192.168.1.4', '10.0.0.2', '172.16.0.1', '172.31.255.1', '127.0.0.1', '::1', 'fd00::1', 'fe80::1', 'abc-123.local', '169.254.1.1']) {
    assert.equal(isLocalAddress(a), true, a);
  }
  for (const a of ['8.8.8.8', '172.32.0.1', '100.64.0.1', '2001:db8::1', '', null]) {
    assert.equal(isLocalAddress(a), false, String(a));
  }
});

test('routes are classified from the selected candidate pair', () => {
  assert.equal(classifyCandidates({ candidateType: 'host' }, { candidateType: 'relay' }).path, 'relayed');
  assert.deepEqual(classifyCandidates({}, { candidateType: 'host', address: '' }), { path: 'direct-local', local: true });
  assert.deepEqual(classifyCandidates({}, { candidateType: 'host', address: 'x.local' }), { path: 'direct-local', local: true });
  assert.deepEqual(classifyCandidates({}, { candidateType: 'prflx', address: '192.168.0.9' }), { path: 'direct-local', local: true });
  assert.deepEqual(classifyCandidates({}, { candidateType: 'srflx', address: '81.2.3.4' }), { path: 'direct-internet', local: false });
  assert.deepEqual(classifyCandidates({}, { candidateType: 'host', address: '81.2.3.4' }), { path: 'direct-internet', local: false });
  assert.deepEqual(classifyCandidates({ candidateType: 'host', address: '81.2.3.9' }, { candidateType: 'host', address: '81.2.3.4' }),
    { path: 'direct-local', local: true }, 'one subnet of public addresses is one network');
  assert.deepEqual(classifyCandidates({ candidateType: 'host', address: '81.2.4.9' }, { candidateType: 'host', address: '81.2.3.4' }),
    { path: 'direct-internet', local: false });
  assert.deepEqual(classifyCandidates({}, { candidateType: 'prflx' }), { path: 'unknown', local: null });
});

test('payload sizes and ids', () => {
  assert.equal(payloadSize('é'), 2);
  assert.equal(payloadSize(new Uint8Array(10)), 10);
  assert.equal(payloadSize({ a: 1 }), 7);
  assert.match(randomId(), /^[0-9A-Za-z]{20}$/);
});
