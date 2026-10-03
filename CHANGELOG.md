# Changelog

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
