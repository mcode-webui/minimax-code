# WebUI built-client browser tests

These tests exercise `dist-webui/client/index.html`, `client.js`, and `styles.css`. Run `pnpm build:webui` first, then `pnpm test:webui-browser`. The script installs the lockfile-pinned Chromium revision when it is missing.

The fixture replaces the browser's `WebSocket` constructor before the built client script executes. The client's normal `createWebuiTransport` path then sends real WebUI wire envelopes to the deterministic in-page fixture. Session IDs, messages, timestamps, cursors, and stream events are synthetic. This covers the built browser client and its transport wiring; it does not start the production WebUI service or a runtime host.

Playwright uses one pinned Linux viewport (1440×900), DPR 1, `zh-CN`, `Asia/Shanghai`, light color scheme, and reduced motion. No screenshot or whole-HTML snapshot is used. Live and completed turn visibility is asserted from controlled stream frames while the indicator remains unmodified.

The harness starts with a random server ID, and every test asserts that both `/health` and the served page report this run's ID. That assertion is registered on the `test` that `harness.mjs` exports, so a spec gets it by importing `test` from there instead of from `@playwright/test` — it cannot be left out by a new spec, and a test that runs against any other build fails instead of passing quietly.

Playwright starts its own harness server on port 4179 and reuses an already-running one only when `WEBUI_BROWSER_REUSE=1` is set. Without it, a busy port is an error rather than a silent adoption of whatever process happens to answer there. Set `WEBUI_BROWSER_SERVER_ID` as well to give a deliberately reused server a known ID that matches the run. CI never reuses either way.

## Specs

- `transcript.spec.mjs` — message paging, live-view ownership, home-turn migration, and the late `questionnaire.dismiss` regression.
- `turn-lifecycle.spec.mjs` — one agent turn end to end: frames through `[DONE]`, mid-turn socket drop and cursor resume, `resume_overflow` resync, a page reload, and a session round trip.
- `harness.mjs` — shared page helpers (fixture configuration, session switching, stream emission, selectors). `fixture.mjs` owns the deterministic in-page transport.
