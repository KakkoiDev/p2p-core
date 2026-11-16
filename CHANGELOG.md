# Changelog

## Unreleased

- `extras/ring.js`: ring people for calls while the page is closed (Web Push). `ringing()` subscribes,
  saves and **probes** with one real test push, remembering whether this browser can ring
  (some Chromium builds pose as Google Chrome yet never receive pushes). `installer()` offers the
  one-click install only where ringing works; `advice()`, `platform()` for the steps to show instead.
- `extras/ring-sw.js`: the service-worker side (ringing notification with Join / Dismiss).
- `server/push.js` (`p2p-core/server/push`): Web Push sending with Node built-ins: RFC 8291
  aes128gcm encryption, VAPID (RFC 8292), an allow-list of real push services, `gone` reporting.
- `examples/ring.html` with `examples/ring-server.mjs`. Tests include the RFC 8291 worked example.

## 0.2.0 — 2026-11-15

- `extras/call.js`: audio/video calls (full mesh) over every transport, negotiated through room
  messages (perfect negotiation, one audio and one video slot per link, track swaps without
  renegotiation, mute/camera/screen state, hang up). `examples/call.html`, Node and Chromium tests.
- Call quality presets (`quality: 'auto' | 'high' | 'max'`): sender bitrate and frame-rate ceilings,
  resolution kept under load, stereo high-bitrate Opus with FEC requested through the SDP.
- Data saving: `'saver'` and `'audio'` presets, `setQuality()` mid-call, and each link using the
  lower of the two people's presets so a phone on a data plan also receives less.
- README: the server protocol, for apps that host the room themselves (DropBox does).
- `p2p-core vendor` prints a clean import path when folders sit behind symlinks (macOS temp dirs).

- Recover Nostr discovery after a failed first connection or socket reconnect.
- Exclude offchain.pub from default signaling after it rejected announcements
  from keys outside its web of trust. Record nos.lol's proof-of-work refusal.
- Distinguish open signaling sockets from established peer connections in
  diagnostics, and keep invite passwords out of handshake errors.

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
