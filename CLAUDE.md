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
- Testing protocol (test-core, pinned in `test-core/` (adopted with test-core's `adopt/adopt.py`; the commit is in `test-core/MANIFEST.json`)): a feature or behaviour change adds or edits its
  Given/When/Then scenario in the `SCENARIOS.md` next to it (`### Scenario: <title>`, then Given/When/Then lines) and
  one e2e test with exactly that title (`e2e/journeys.test.js` for two peers on the in-memory network,
  `e2e/browser.spec.mjs` for anything on a page). Find controls by role or label; a new control needs a step, and
  removing one means removing its step and scenario in the same commit. No fixed waits (wait for an event, a
  locator or `network.settle()`); no real hosts. `npm run test:e2e`, `npm run test:browser`, then
  `npm run test:protocol` must pass. Chromium is launched with `--use-mock-keychain --password-store=basic`.
- Headless Chromium cannot resolve mDNS host candidates; the browser run disables mDNS hiding.
  Route classification (`src/route.js`) treats a host candidate with no address as local for that
  reason, and a public host address as local only on the same /24.
- Releases are git tags `vX.Y.Z` (no npm account). Bump `package.json` and `VERSION` in
  `src/room.js` together; a test checks it.
