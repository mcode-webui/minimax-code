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
  const brokenReason = rowOf(page, "broken-http").locator("[data-webui-mcp-status-reason]");
  await expect(brokenReason).toHaveText("MCP_CONNECTION_TIMEOUT: 握手超时（10s）");
  const secondaryText = await page.evaluate(() => {
    const probe = document.createElement("span");
    probe.style.color = "var(--text_default_secondary)";
    document.body.append(probe);
    const color = getComputedStyle(probe).color;
    probe.remove();
    return color;
  });
  expect(await brokenReason.evaluate((node) => getComputedStyle(node).color))
    .toBe(secondaryText);

  const gone = rowOf(page, "gone-binary").locator("[data-webui-mcp-status]");
  await expect(gone).toHaveText("不可用");
  await expect(gone).toHaveAttribute("data-webui-mcp-status", "unavailable");
  const goneReason = rowOf(page, "gone-binary").locator("[data-webui-mcp-status-reason]");
  await expect(goneReason).toHaveText("MCP_COMMAND_NOT_FOUND: ./missing-bin");
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

test("a late MCP detail cannot attach to a different management selection", async ({ page }) => {
  await stageMcpServers(page, [
    { name: "delayed-server", transport: "stdio", enabled: true, status: "configured" },
  ]);
  await page.addInitScript(() => {
    window.__WEBUI_FIXTURE_SETUP__ ??= [];
    window.__WEBUI_FIXTURE_SETUP__.push(() =>
      window.__fixture.delayNext("pluginManagement", { action: "getMcpServer" }),
    );
  });
  await openApp(page, "#session=A");
  await openMcpArea(page);
  await rowOf(page, "delayed-server").getByRole("button", { name: "编辑" }).click();
  await expect.poll(() => page.evaluate(() =>
    window.__fixture.requests.some((request) =>
      request.operation === "pluginManagement" && request.body.action === "getMcpServer",
    ),
  )).toBe(true);

  await page.locator('.webui-plugin-category-filter button', { hasText: "Agents" }).click();
  const released = await page.evaluate(() =>
    window.__fixture.resolveAllPending(
      "pluginManagement",
      { action: "getMcpServer" },
      { name: "delayed-server", command: "synthetic" },
    ),
  );
  expect(released).toBe(1);
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.locator(".webui-agent-editor")).toBeVisible();
});

test("a late Git preview cannot populate a replacement import dialog", async ({ page }) => {
  await page.addInitScript(() => {
    window.__WEBUI_FIXTURE_SETUP__ ??= [];
    window.__WEBUI_FIXTURE_SETUP__.push(() =>
      window.__fixture.delayNext("pluginManagement", { action: "previewGithubPlugin" }),
    );
  });
  await openApp(page, "#session=A");
  await page.getByRole("button", { name: "插件" }).first().click();
  await page.locator(".webui-plugin-manage-trigger").click();
  await page.locator(".webui-plugin-create-trigger").click();
  await page.getByRole("menuitem", { name: "从 Git 仓库导入插件" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("textbox", { name: "仓库 URL" }).fill("https://github.com/old/repository");
  await dialog.getByRole("button", { name: "预览" }).click();
  await expect.poll(() => page.evaluate(() =>
    window.__fixture.requests.some((request) =>
      request.operation === "pluginManagement" && request.body.action === "previewGithubPlugin",
    ),
  )).toBe(true);

  await dialog.getByRole("button", { name: "关闭" }).click();
  await page.locator(".webui-plugin-create-trigger").click();
  await page.getByRole("menuitem", { name: "从 Git 仓库导入插件" }).click();
  const replacement = page.getByRole("dialog");
  await replacement.getByRole("textbox", { name: "仓库 URL" }).fill("https://github.com/new/repository");
  const released = await page.evaluate(() =>
    window.__fixture.resolveAllPending(
      "pluginManagement",
      { action: "previewGithubPlugin" },
      {
        canImport: true,
        plugin: { summary: { name: "stale-plugin", displayName: "Stale preview" } },
      },
    ),
  );
  expect(released).toBe(1);
  await expect(replacement.getByRole("textbox", { name: "仓库 URL" })).toHaveValue(
    "https://github.com/new/repository",
  );
  await expect(replacement.getByRole("button", { name: "预览" })).toBeVisible();
  await expect(replacement.getByText("Stale preview")).toHaveCount(0);
});

test("closing an import dialog does not cancel an accepted mutation settlement", async ({ page }) => {
  await page.addInitScript(() => {
    window.__WEBUI_FIXTURE_SETUP__ ??= [];
    window.__WEBUI_FIXTURE_SETUP__.push(() => {
      window.__fixture.setPluginManagementResult("previewGithubPlugin", {
        canImport: true,
        source: {
          repositoryUrl: "https://github.com/owner/repository",
          commitSha: "abc123",
        },
        plugin: { summary: { name: "imported", displayName: "Importable" } },
      });
      window.__fixture.delayNext("pluginManagement", { action: "importGithubPlugin" });
    });
  });
  await openApp(page, "#session=A");
  await page.getByRole("button", { name: "插件" }).first().click();
  await page.locator(".webui-plugin-manage-trigger").click();
  await page.locator(".webui-plugin-create-trigger").click();
  await page.getByRole("menuitem", { name: "从 Git 仓库导入插件" }).click();
  const initial = page.getByRole("dialog");
  await initial.getByRole("textbox", { name: "仓库 URL" }).fill("https://github.com/owner/repository");
  await initial.getByRole("button", { name: "预览" }).click();
  await expect(initial.getByText("Importable")).toBeVisible();
  await initial.getByRole("button", { name: "导入插件" }).click();
  await expect.poll(() => page.evaluate(() =>
    window.__fixture.requests.some((request) =>
      request.operation === "pluginManagement" && request.body.action === "importGithubPlugin",
    ),
  )).toBe(true);

  const listCountBeforeSettle = await page.evaluate(() =>
    window.__fixture.requests.filter((request) =>
      request.operation === "pluginManagement" && request.body.action === "listInstalledPlugins",
    ).length,
  );
  await initial.getByRole("button", { name: "关闭" }).click();
  await page.locator(".webui-plugin-create-trigger").click();
  await page.getByRole("menuitem", { name: "从 Git 仓库导入插件" }).click();
  const replacement = page.getByRole("dialog");

  const released = await page.evaluate(() =>
    window.__fixture.resolveAllPending(
      "pluginManagement",
      { action: "importGithubPlugin" },
      { ok: true },
    ),
  );
  expect(released).toBe(1);
  await expect(replacement).toBeVisible();
  await expect.poll(() => page.evaluate(() =>
    window.__fixture.requests.filter((request) =>
      request.operation === "pluginManagement" && request.body.action === "listInstalledPlugins",
    ).length,
  )).toBeGreaterThan(listCountBeforeSettle);
});
