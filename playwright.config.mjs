import { defineConfig } from "@playwright/test";
import { randomUUID } from "node:crypto";

const serverId = process.env.WEBUI_BROWSER_SERVER_ID ?? randomUUID();
process.env.WEBUI_BROWSER_SERVER_ID = serverId;

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
  testDir: "./test/webui-browser",
  outputDir: process.env.WEBUI_BROWSER_OUTPUT_DIR ?? "/tmp/minimax-webui-browser-results",
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
  },
  webServer: {
    command: "node test/webui-browser/server.mjs",
    url: "http://127.0.0.1:4179/health",
    reuseExistingServer,
    env: { ...process.env, WEBUI_BROWSER_SERVER_ID: serverId },
    timeout: 15_000,
  },
});
