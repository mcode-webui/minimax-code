// The MCP servers' connection state on the plugin panel, end to end against
// the built client.
//
// Roadmap D-3 (as transcribed): 「MCP 插件连不上时，界面上要看得见」. The
// runtime classifies every server and attaches the failure's own reason to
// the trouble states; the panel's MCP rows used to render none of it, so a
// dead server was visually identical to a healthy one. This spec walks the
// real path a user walks — rail 插件 → 管理 → MCP — and reads the placed,
// loaded rows: every state labelled, the two failure states carrying their
// server's own reason as visible text.

import { expect } from "@playwright/test";

import { openApp, test } from "./harness.mjs";

test.beforeEach(async ({ page }) => {
  page.on("pageerror", (error) => console.error("BROWSER_PAGE_ERROR", error.stack ?? error.message));
  page.on("console", (message) => { if (message.type() === "error") console.error("BROWSER_CONSOLE_ERROR", message.text()); });
});

/** Stages the MCP listing before boot; the panel's reload picks it up. */
async function stageMcpServers(page, servers) {
  await page.addInitScript((value) => {
    window.__WEBUI_FIXTURE_SETUP__ ??= [];
    window.__WEBUI_FIXTURE_SETUP__.push(() =>
      window.__fixture.setPluginManagementResult("listMcpServers", value),
    );
  }, { servers });
}

async function openMcpArea(page) {
  await page.getByRole("button", { name: "插件" }).first().click();
  await page.locator(".webui-plugin-manage-trigger").click();
  await page.locator('.webui-plugin-category-filter button', { hasText: "MCP" }).click();
}

function rowOf(page, name) {
  return page.locator(".webui-plugin-row", { hasText: name });
}

test("a server that cannot connect is labelled 连接失败 with its own reason", async ({ page }) => {
  await stageMcpServers(page, [
    {
      name: "broken-http",
      transport: "http",
      enabled: true,
      status: "error",
      available: false,
      error: "MCP_CONNECTION_TIMEOUT: 握手超时（10s）",
    },
    {
      name: "gone-binary",
      transport: "stdio",
      enabled: true,
      status: "unavailable",
      available: false,
      error: "MCP_COMMAND_NOT_FOUND: ./missing-bin",
    },
  ]);
  await openApp(page, "#session=A");
  await openMcpArea(page);

  // The failure states come with their server's own reason as visible text —
  // not a tooltip, because nobody hovers a row they believe is healthy.
  const broken = rowOf(page, "broken-http").locator("[data-webui-mcp-status]");
  await expect(broken).toHaveText("连接失败");
  await expect(broken).toHaveAttribute("data-webui-mcp-status", "error");
  await expect(rowOf(page, "broken-http").locator("[data-webui-mcp-status-reason]"))
    .toHaveText("MCP_CONNECTION_TIMEOUT: 握手超时（10s）");

  const gone = rowOf(page, "gone-binary").locator("[data-webui-mcp-status]");
  await expect(gone).toHaveText("不可用");
  await expect(gone).toHaveAttribute("data-webui-mcp-status", "unavailable");
  await expect(rowOf(page, "gone-binary").locator("[data-webui-mcp-status-reason]"))
    .toHaveText("MCP_COMMAND_NOT_FOUND: ./missing-bin");
});

test("the calm states are labelled too, so trouble has honest neighbours", async ({ page }) => {
  // Without the quiet half, every label would read as an alarm: a panel that
  // says 未连接 on a resting server and 连接失败 on a dead one is legible;
  // one that says nothing except on failure is a trap.
  await stageMcpServers(page, [
    { name: "ok-stdio", transport: "stdio", enabled: true, status: "available", available: true },
    { name: "idle", transport: "stdio", enabled: true, status: "configured", available: false },
    { name: "off", transport: "http", enabled: false, status: "disabled", available: false },
  ]);
  await openApp(page, "#session=A");
  await openMcpArea(page);

  await expect(rowOf(page, "ok-stdio").locator("[data-webui-mcp-status]")).toHaveText("已连接");
  await expect(rowOf(page, "idle").locator("[data-webui-mcp-status]")).toHaveText("未连接");
  await expect(rowOf(page, "off").locator("[data-webui-mcp-status]")).toHaveText("已停用");
  // And no row invents a reason where the runtime gave none.
  await expect(page.locator("[data-webui-mcp-status-reason]")).toHaveCount(0);
});
