# @mavis/browser-extension

The Edge/Chrome extension that bridges a person's own browser to a local WebUI
host, so the person and the Agent operate **one** browser session rather than two.
It is the extension half of ADR 0019.

## What it does

- Pairs with the local WebUI over a loopback WebSocket at `/browser-bridge`,
  using challenge-response rather than a bearer token.
- Reports the tabs it can reach, each with a generation that rises whenever the
  page behind the tab is replaced.
- Streams live images of the visible tab for the panel.
- Delivers pointer, keyboard and text input into the tab the Agent addressed.

## Layout

| File | Purpose |
| --- | --- |
| `manifest.json` | The MV3 manifest: permissions, loopback host permissions, no remote code. |
| `src/chrome.d.ts` | The subset of the Chrome API this extension uses; `@types/chrome` is unavailable to an extension. |
| `src/protocol.ts` | The extension's copy of the bridge wire protocol, pinned to the host's signature test vector. |
| `src/pairing.ts` | The pairing credential in `chrome.storage.local` and the challenge answer. |
| `src/bridge-client.ts` | The loopback WebSocket client, the reconnect schedule and the operation deadline. |
| `src/targets.ts` | Tab discovery and the generation registry. |
| `src/images.ts` | The visible-tab image stream. |
| `src/input.ts` | Pointer / keyboard / text delivery, bound to target and generation. |
| `src/background/service-worker.ts` | The MV3 entry point that wires the above together. |

## Running it

Load `packages/browser-extension/` as an unpacked extension
(`chrome://extensions` → Developer mode → Load unpacked), then set the bridge
origin in extension storage:

```json
{ "webui.browserBridge.origin": "http://127.0.0.1:<webui-port>" }
```

The extension cannot learn the host's address by itself, so an absent origin is
reported rather than replaced with a guessed default port.

The bridge path, the frame shapes and the signature construction are duplicated
from `packages/webui/src/shared/contracts/browser-bridge.ts`: an extension has no
node_modules and no bundler, so it cannot import a workspace package. Both sides
are pinned to the same test vector
(`secret = "webui-browser-bridge-test-secret"`, `nonce = "nonce-abc"`,
`keyId = "key-1"` → `xb7/GT5s+ScVsaiLkh+eRRndKi5oPQwqQMqU3aX8Znc=`), so a change
to either side breaks one suite rather than silently failing to pair.

## Two limitations that shape the product

- **Only the visible tab can be captured.** `chrome.debugger` does not expose
  `Page.captureScreenshot`, so `chrome.tabs.captureVisibleTab` is the only image
  path, and it returns nothing for a background tab. The extension reports "no
  frame" rather than substituting another tab's page.
- **No remote code and no `<all_urls>`.** The content security policy allows only
  `'self'` scripts, and host permissions cover the two loopback origins the
  bridge needs. Page access comes from `tabs`/`debugger`/`activeTab`, not from a
  blanket host grant.

## Verification

```
pnpm --filter @mavis/browser-extension typecheck
pnpm --filter @mavis/browser-extension test
```

## Store distribution

Chrome Web Store and Edge Add-ons artifacts are a separate release action. Both
builds come from this one source package; a store build needs a compiled service
worker (`dist/background/service-worker.js`) with `manifest.json` pointing at the
built path, since a browser cannot execute the TypeScript sources directly. This
package deliberately declares no build step, so that compilation belongs to the
packaging change rather than to the bridge implementation.