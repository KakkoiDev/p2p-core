# Changelog

## Unreleased

- matchmaking: a third player who was mid-offer when the other two matched is now told the room is
  full (before, it waited forever: the matched pair never announces again). Found by the new
  scenario journey "A third player is told the room is full and never hears the game".
- Testing protocol from test-core: `SCENARIOS.md` per module, one e2e test per scenario, control
  coverage and flaky lint in CI (test-core adopted into `test-core/` with its adopt kit).

## 0.1.0 — 2026-10-03

First release.

- `joinRoom()` merging five transports into one peer list: other tabs (BroadcastChannel), internet
  relays (trystero 0.21.5 over nostr, vendored), a local server (`npx p2p-core serve`), pairing codes
  (manual WebRTC with QR codes), and an in-memory test network.
- `mode` (`auto`, `online`, `offline`, `tabs`) and `allow` (`sameBrowser`, `sameNetwork`,
  `otherNetworks`), with WebRTC route classification behind the network rules.
- Security options: `password`, `protocol`, `acceptPeer`, `maxPeers`, `validate`, `rateLimit`,
  `maxMessageBytes`.
- trystero-compatible room shape (`makeAction`, `onPeerJoin`, `getPeers`, …) plus `send`,
  `onMessage`, profiles, host election, `status()`, `route()`, `ping()`.
- Extras: matchmaking (from schness), presence (from kakkoi-online), shared state, pairing dialog,
  connection badge, QR draw/scan.
- CLI: `serve`, `vendor`, `files`, `version`.
- The shared, append-only relay list: the union of schness's and kakkoi-online's, minus the relays
  kakkoi-online recorded refusing our notes (`REFUSING_RELAYS`).
- `selfId` (this page's id) is exported.
