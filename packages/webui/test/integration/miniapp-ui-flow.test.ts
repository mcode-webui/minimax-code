// The Mini App buttons a person actually clicks, against the real host.
//
// `miniapp-real-flow.test.ts` proves the flow at the wire. This file proves
// the surface: the built client, in a real browser, against the same real host,
// with the real Mini App installed and the real runner starting it.
//
// The browser specs that exist today cover the Mini App panel against a
// fixture transport and a stub page — a paragraph of HTML that cannot fail to
// render. So the buttons, the states they produce and the page behind them
// were never exercised against a product that could actually fail.
//
// What this file pins:
//
//   * the row a person sees appears, with the state the runtime reports;
//   * 打开 starts the Mini App and the row says so;
//   * 查看 opens the standalone tab, and the Mini App's own page renders there;
//   * 停止 stops it;
//   * 停用, 启用 and 卸载 never do nothing silently: whatever they answer is
//     visible on the surface.
//
// The data directory is temporary, so a run can never reach the operator's own
// `~/.minimax`.

import { afterEach, describe, expect, it } from "vitest";
import { chromium, expect as browserExpect, type Page } from "@playwright/test";

import {
  LOCAL_SOURCE,
  PAGE_MARKER,
  bootRealHost,
  closeAllBootedHosts,
  connect,
  publishLocalPackage,
} from "./miniapp-real-flow-support.js";

const PLUGIN = "surface.miniapp";

afterEach(async () => {
  await closeAllBootedHosts();
});

/**
 * Opens the management surface on the applications area.
 *
 * The path is the person's own: the plugins button in the sidebar, then the
 * management button, then the applications tab of the management view.
 */
async function openApplications(page: Page): Promise<void> {
  await page.getByRole("button", { name: "插件" }).first().click();
  await page.getByTestId("plugin-manage-trigger").click();
  await page
    .locator('.webui-plugin-category-filter[aria-label="插件管理分类"] button', { hasText: "应用" })
    .click();
  await browserExpect(page.getByTestId(`miniapp-app-${PLUGIN}`)).toBeVisible();
}

describe("the Mini App management surface against the real host", () => {
  it("starts, shows, stops, disables, enables and uninstalls a Mini App", async () => {
    const host = await bootRealHost({ dev: true, serveBuiltClient: true });
    const client = await connect(host.url);
    await publishLocalPackage(host.dataDir, PLUGIN);
    await client.call("pluginManagement", {
      action: "enablePlugin",
      input: { pluginName: PLUGIN, source: LOCAL_SOURCE },
    });
    // A session, so the catalogue can offer the standalone tab: its deep link
    // names the session the Mini App belongs to.
    const created = await client.call("createSession", {
      name: "main",
      workspaceDir: host.dataDir,
    });
    const sessionId = (
      created.body as { session?: { sessionId?: string } } | undefined
    )?.session?.sessionId;
    expect(typeof sessionId).toBe("string");

    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage({
        locale: "zh-CN",
        viewport: { width: 1440, height: 900 },
      });
      // The uninstall button asks for confirmation; a browser that dismisses it
      // would silently skip the step this gate is about.
      page.on("dialog", (dialog) => void dialog.accept());

      await page.goto(
        `http://127.0.0.1:${host.tcpPort}/?token=miniapp-real-flow-token#session=${sessionId}`,
      );
      await browserExpect(page.locator("#webui-root")).toBeVisible();

      await openApplications(page);
      await browserExpect(page.getByTestId(`miniapp-app-status-${PLUGIN}`)).toHaveAttribute(
        "data-status",
        "stopped",
      );

      // 打开 — the Mini App starts, and the row says it is running.
      await page.getByTestId(`miniapp-app-open-${PLUGIN}`).click();
      await browserExpect(page.getByTestId(`miniapp-app-status-${PLUGIN}`)).toHaveAttribute(
        "data-status",
        "running",
      );

      // 查看 — the standalone tab opens, and the Mini App's own page renders in
      // it. This is the deep link a person shares, so the page behind it has to
      // be the Mini App and not an empty frame.
      const standalone = browser.contexts()[0]?.waitForEvent("page");
      await page.getByRole("button", { name: "查看" }).click();
      const standalonePage = await standalone;
      expect(standalonePage).toBeTruthy();
      await standalonePage.waitForLoadState("domcontentloaded");
      // The standalone document is the shell, and the Mini App is framed inside
      // it — so the page the person sees is one level down.
      await browserExpect(
        standalonePage.frameLocator("iframe").getByText(PAGE_MARKER).first(),
      ).toBeVisible();
      await standalonePage.close();

      // 停止 — the Mini App stops, and the row says so.
      await page.getByRole("button", { name: "停止" }).click();
      await browserExpect(page.getByTestId(`miniapp-app-status-${PLUGIN}`)).toHaveAttribute(
        "data-status",
        "stopped",
      );

      // 停用 — the Mini App leaves the startable set. This is a local
      // package, so the surface has to say which path the runtime should take;
      // when it did not, the change was read as an official one, refused with
      // an authentication error, and the row stayed exactly as it was.
      const row = page.getByTestId(`miniapp-app-${PLUGIN}`);
      await row.getByRole("button", { name: "停用" }).click();
      await browserExpect(row.getByRole("button", { name: "启用" })).toBeVisible();
      await browserExpect(page.getByTestId(`miniapp-app-status-${PLUGIN}`)).toContainText("已停用");

      // 启用 — the same contract on the way back.
      await row.getByRole("button", { name: "启用" }).click();
      await browserExpect(row.getByRole("button", { name: "停用" })).toBeVisible();

      // 卸载 — and the row leaves the catalogue.
      await row.getByRole("button", { name: "卸载" }).click();
      await browserExpect(page.getByTestId(`miniapp-app-${PLUGIN}`)).toHaveCount(0);
    } finally {
      await browser.close();
    }
  }, 180_000);

  it("reports a Mini App that cannot start instead of leaving the person waiting", async () => {
    const host = await bootRealHost({ dev: true, serveBuiltClient: true });
    const client = await connect(host.url);
    await publishLocalPackage(host.dataDir, PLUGIN, { broken: true });
    await client.call("pluginManagement", {
      action: "enablePlugin",
      input: { pluginName: PLUGIN, source: LOCAL_SOURCE },
    });

    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage({
        locale: "zh-CN",
        viewport: { width: 1440, height: 900 },
      });
      page.on("dialog", (dialog) => void dialog.accept());

      await page.goto(`http://127.0.0.1:${host.tcpPort}/?token=miniapp-real-flow-token`);
      await browserExpect(page.locator("#webui-root")).toBeVisible();
      await openApplications(page);

      await page.getByTestId(`miniapp-app-open-${PLUGIN}`).click();
      // The refusal is shown on the row, and it names the failure rather than
      // leaving an empty state.
      const refusal = page.getByTestId(`miniapp-app-refusal-${PLUGIN}`);
      await browserExpect(refusal).toBeVisible();
      await browserExpect(refusal).not.toBeEmpty();
      // The row says the start failed. It used to keep saying "已停止", which
      // reads as a Mini App that ran and was stopped — and hides the reason
      // the person needs.
      await browserExpect(page.getByTestId(`miniapp-app-status-${PLUGIN}`)).toHaveAttribute(
        "data-status",
        "failed",
      );
      await browserExpect(page.getByTestId(`miniapp-app-status-${PLUGIN}`)).toContainText("启动失败");
    } finally {
      await browser.close();
    }
  }, 180_000);
});
