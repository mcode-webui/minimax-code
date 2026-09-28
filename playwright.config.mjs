import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./test/webui-browser",
  outputDir: process.env.WEBUI_BROWSER_OUTPUT_DIR ?? "/tmp/minimax-webui-browser-results",
  fullyParallel: false,
  workers: 1,
  reporter: "list",
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
    reuseExistingServer: !process.env.CI,
    timeout: 15_000,
  },
});
