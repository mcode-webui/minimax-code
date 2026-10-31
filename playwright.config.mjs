import { defineConfig } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

import { prepareFontEnvironment } from "./scripts/lib/webui-font-environment.mjs";

const root = fileURLToPath(new URL(".", import.meta.url));
const serverId = process.env.WEBUI_BROWSER_SERVER_ID ?? randomUUID();
process.env.WEBUI_BROWSER_SERVER_ID = serverId;

// The visual baselines compare pixels, so the glyphs they draw have to be the
// same on every machine. The host's installed fonts are not: the CI image
// changes, the gate's browser dependency install pulls a different font
// package set over time, and the host's fontconfig decides between LCD
// subpixel fringes and grayscale antialiasing. The browser therefore runs
// under a fontconfig that exposes only the font files committed to
// `packages/webui/test/browser/fonts/`, so the rendering depends on this
// repository and on nothing else.
const outputDirectory =
  process.env.WEBUI_BROWSER_OUTPUT_DIR ?? "/tmp/minimax-webui-browser-results";
const fontEnvironment = prepareFontEnvironment(root, {
  cacheDirectory: outputDirectory,
});

// `reuseExistingServer` is opt-in. Playwright only probes the url for
// reachability, so reusing by default meant that *any* process answering on the
// harness port was silently adopted: the suite then ran against whatever artifact
// that process was serving, under a server id the in-test guard rejects only if
// the guard happens to run. Reusing is still useful for a deliberate local loop
// against one known-good server, so `WEBUI_BROWSER_REUSE=1` asks for it
// explicitly and anything else fails loudly on a busy port instead. CI never
// reuses: it is a fresh machine per run and has nothing to reuse.
const reuseExistingServer = !process.env.CI && process.env.WEBUI_BROWSER_REUSE === "1";

export default defineConfig({
  testDir: "./packages/webui/test/browser",
  outputDir: outputDirectory,
  fullyParallel: false,
  workers: 1,
  reporter: "list",
  metadata: { webuiBrowserServerId: serverId },
  use: {
    baseURL: "http://127.0.0.1:4179",
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 1,
    locale: "zh-CN",
    timezoneId: "Asia/Shanghai",
    colorScheme: "light",
    reducedMotion: "reduce",
    browserName: "chromium",
    headless: true,
    trace: "retain-on-failure",
    launchOptions: {
      env: { ...process.env, ...fontEnvironment.env },
    },
  },
  webServer: {
    command: "node packages/webui/test/browser/server.mjs",
    url: "http://127.0.0.1:4179/health",
    reuseExistingServer,
    env: { ...process.env, WEBUI_BROWSER_SERVER_ID: serverId },
    timeout: 15_000,
  },
});
