import test from 'node:test';
import assert from 'node:assert/strict';
import { RELAYS } from '../p2p-core.js';
import { REFUSING_RELAYS } from '../src/relays.js';

test('the relay list is long enough that one dead relay is not a dead app', () => {
  assert.ok(RELAYS.length >= 8);
  assert.equal(new Set(RELAYS).size, RELAYS.length, 'a relay is listed twice');
  for (const url of RELAYS) assert.match(url, /^wss:\/\/[a-z0-9.-]+(\/\S*)?$/i);
  assert.ok(Object.isFrozen(RELAYS), 'apps must not edit the shared list in place');
});

test('no relay is ever removed: older builds still dial them', () => {
  // Every relay any p2p-core release — or the apps it came from — has shipped.
  // Append to this list when you add a relay. Never delete from it.
  const published = [
    'wss://relay.snort.social', 'wss://nostr.sathoarder.com', 'wss://nostr.vulpem.com',
    'wss://relay.primal.net', 'wss://nostr.mom', 'wss://offchain.pub', 'wss://eu.purplerelay.com',
    'wss://nostr.data.haus', 'wss://relay.fountain.fm', 'wss://relay.nostromo.social',
  ];
  for (const url of published) {
    if (REFUSING_RELAYS.includes(url)) continue;
    assert.ok(RELAYS.includes(url), `${url} was removed; older builds still dial it`);
  }
});

test('relays known to refuse our notes are not dialled', () => {
  for (const url of REFUSING_RELAYS) assert.ok(!RELAYS.includes(url), `${url} refuses posts; it only adds console warnings`);
});

test('package.json and VERSION agree', async () => {
  const { readFile } = await import('node:fs/promises');
  const { VERSION } = await import('../p2p-core.js');
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url)));
  assert.equal(VERSION, pkg.version);
});
