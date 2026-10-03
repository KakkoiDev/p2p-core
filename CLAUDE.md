# Working on p2p-core

- `AGENTS.md` is for agents *using* the library; keep it short and true. `README.md` is the manual.
  A behaviour change is not done until both say the new thing.
- No build step and no runtime dependencies. Browser code is plain ES modules; anything that needs
  a library vendors a pinned copy under `vendor/` and lists it in `THIRD_PARTY_NOTICES.md`.
  Never edit vendored files.
- `src/relays.js` is append-only (old builds still dial the old list). `test/relays.test.js` holds
  every relay ever shipped; add new ones there too.
- The vendored trystero stays byte-compatible with the copy schness and kakkoi-online shipped
  (0.21.5) until both apps move together: cached old builds must still find new ones.
- `npm test` (Node) and `npm run test:browser` (Chromium; `CHROMIUM=/path` if not at
  `/opt/pw-browsers/chromium`) must both pass. The browser run is the only check of real WebRTC,
  pairing and trystero signalling (through `e2e/nostr-relay.mjs`).
- Headless Chromium cannot resolve mDNS host candidates; the browser run disables mDNS hiding.
  Route classification (`src/route.js`) treats a host candidate with no address as local for that
  reason, and a public host address as local only on the same /24.
- Releases are git tags `vX.Y.Z` (no npm account). Bump `package.json` and `VERSION` in
  `src/room.js` together; a test checks it.
