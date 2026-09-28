# WebUI built-client browser tests

These tests exercise `dist-webui/client/index.html`, `client.js`, and `styles.css`. Run `pnpm build:webui` first, then `pnpm test:webui-browser`. The script installs the lockfile-pinned Chromium revision when it is missing.

The fixture replaces the browser's `WebSocket` constructor before the built client script executes. The client's normal `createWebuiTransport` path then sends real WebUI wire envelopes to the deterministic in-page fixture. Session IDs, messages, timestamps, cursors, and stream events are synthetic. This covers the built browser client and its transport wiring; it does not start the production WebUI service or a runtime host.

Playwright uses one pinned Linux viewport (1440×900), DPR 1, `zh-CN`, `Asia/Shanghai`, light color scheme, and reduced motion. No screenshot or whole-HTML snapshot is used. Live and completed turn visibility is asserted from controlled stream frames while the indicator remains unmodified.
