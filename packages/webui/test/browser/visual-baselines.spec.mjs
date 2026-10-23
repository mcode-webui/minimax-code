// Representative Linux Chromium screenshot baselines for stable WebUI surfaces.
// DOM and geometry assertions remain independent from the screenshot oracle.

import { expect } from "@playwright/test";

import {
  assistantBody,
  emitAgentMessage,
  emitStream,
  openApp,
  startTurn,
  test,
} from "./harness.mjs";

async function assertInViewport(locator, page) {
  const box = await locator.boundingBox();
  expect(box).not.toBeNull();
  expect(box.width).toBeGreaterThan(0);
  expect(box.height).toBeGreaterThan(0);
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.y).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(1440);
  expect(box.y + box.height).toBeLessThanOrEqual(900);
  await expect(locator).toBeVisible();
}

test("shell and session rail layout baseline", async ({ page }) => {
  await openApp(page, "#session=A");

  const shell = page.locator("#webui-root");
  const rail = page.locator(".webui-rail");
  await assertInViewport(shell, page);
  await expect(rail).toBeVisible();
  await expect(rail.getByText("Synthetic session A")).toBeVisible();
  await expect(rail.getByText("Synthetic session B")).toBeVisible();
  await expect.poll(() => page.locator('img[src^="/assets/"]').evaluateAll((images) =>
    images.every((image) => image instanceof HTMLImageElement && image.complete && image.naturalWidth > 0),
  )).toBe(true);
  await expect(shell).toHaveScreenshot("shell-and-rail.png", { animations: "disabled" });
});

test("transcript and composer layout baseline", async ({ page }) => {
  await openApp(page, "#session=A");
  await startTurn(page, "A", "Snapshot synthetic user prompt");
  await emitAgentMessage(page, "A", {
    msg_id: "visual-baseline-assistant",
    thinking_content: "Synthetic reasoning for visual review.",
    msg_content: "Synthetic final answer for visual review.",
  });
  await expect(assistantBody(page, "visual-baseline-assistant").getByText("Synthetic final answer for visual review.")).toBeVisible();
  // A completed turn reconciles against getMessages. Keep the fixture's
  // authoritative history in sync with the streamed rows instead of letting
  // the default seed page erase them at DONE.
  await page.evaluate(() => {
    window.__fixture.setPage("A", {
      messages: [
        { msgId: "history-A", role: "user", msgContent: "History A synthetic", timestamp: 1_700_000_000_001 },
        { msgId: "visual-baseline-user", role: "user", msgContent: "Snapshot synthetic user prompt", timestamp: 1_700_000_000_010 },
        {
          msgId: "visual-baseline-assistant",
          role: "assistant",
          msgContent: "Synthetic final answer for visual review.",
          thinkingContent: "Synthetic reasoning for visual review.",
          timestamp: 1_700_000_000_011,
        },
      ],
      hasMore: false,
    });
    window.__fixture.setTurnDiff({
      status: "active",
      changeSetId: "cs-visual-baseline",
      sourceMessageId: "visual-baseline-assistant",
      canUndo: true,
      canReapply: false,
      fileChanges: [{ file: "a.ts", additions: 2, deletions: 1 }],
    });
  });
  await emitStream(page, "A", { dataJson: "[DONE]" });
  await expect(page.getByText("Snapshot synthetic user prompt")).toBeVisible();
  await expect(assistantBody(page, "visual-baseline-assistant").getByText("Synthetic final answer for visual review.")).toBeVisible();
  await expect(page.getByTestId("turn-diff-card")).toBeVisible();

  const transcript = page.locator('[data-webui-transcript="A"]');
  await assertInViewport(transcript, page);
  await expect(page.getByPlaceholder("输入消息…（输入 / 唤起命令）")).toBeVisible();
  await expect(page.locator("#webui-root")).toHaveScreenshot("transcript-and-composer.png", { animations: "disabled" });
});

test("settings dialog layout baseline", async ({ page }) => {
  await openApp(page, "#session=A");
  await page.locator('[data-testid="sidebar-user-menu-trigger"]').click();
  await page.locator('[data-testid="user-menu-settings"]').click();

  const dialog = page.locator('[role="dialog"][aria-label="设置"]');
  await assertInViewport(dialog, page);
  await expect(dialog.getByRole("heading", { name: "通用", exact: true })).toBeVisible();
  // The overlay fades in and the panel behind it slides in, so a frame taken
  // while either is still moving is a frame the next run does not repeat. The
  // same wait the browser panel case uses, over the whole subtree, so this
  // records the settled frame rather than a lucky one.
  await dialog.evaluate(async (element) => {
    const finite = element.getAnimations({ subtree: true }).filter((animation) => {
      const timing = animation.effect?.getComputedTiming();
      return timing ? Number.isFinite(timing.endTime) : false;
    });
    await Promise.all(finite.map((animation) => animation.finished.catch(() => undefined)));
  });
  await expect(dialog).toHaveScreenshot("settings-dialog.png", { animations: "disabled" });
});

test("progress panel layout baseline", async ({ page }) => {
  await openApp(page, "#session=A");
  await page.evaluate(() => window.__fixture.emitEvent({
    type: "session.start",
    payload: { sessionId: "A", turnId: "visual-progress-turn" },
    timestamp: 1_700_000_000_300,
    source: "synthetic",
  }));
  await expect.poll(() => page.evaluate(() => window.__fixture.requests.some(
    (request) => request.operation === "resumeSession" && request.body.id === "A",
  ))).toBe(true);
  await emitAgentMessage(page, "A", {
    msg_id: "visual-progress-todo",
    msg_content: JSON.stringify({
      eventType: "todo_updated",
      todos: [{ content: "Synthetic visual todo", status: "in_progress", priority: "high" }],
    }),
  });

  const panel = page.getByTestId("progress-overview-panel");
  await expect(panel).toContainText("Synthetic visual todo");
  await assertInViewport(panel, page);
  await expect(panel).toHaveScreenshot("progress-panel.png", { animations: "disabled" });
});

test("embedded browser panel layout baseline", async ({ page }) => {
  await openApp(page, "#session=A");
  await page.getByTestId("workspace-panel-controls").getByRole("button", { name: "浏览器" }).click();

  const panel = page.getByTestId("workspace-panel");
  await expect(panel).toHaveAttribute("data-active-tab", "launcher");
  await panel.evaluate(async (element) => {
    await Promise.all(element.getAnimations().map((animation) => animation.finished));
  });
  await assertInViewport(panel, page);
  await expect(page.getByTestId("workspace-launcher")).toBeVisible();
  await expect(panel).toHaveScreenshot("embedded-browser-panel.png", { animations: "disabled" });
});

test("composer command overlay layout baseline", async ({ page }) => {
  await openApp(page, "#session=A");
  const composer = page.getByPlaceholder("输入消息…（输入 / 唤起命令）");
  await composer.click();
  await composer.pressSequentially("/");

  const overlay = page.locator('[data-webui-command-menu="true"]');
  await expect(overlay).toBeVisible();
  await assertInViewport(overlay, page);
  await expect(overlay).toHaveScreenshot("composer-command-overlay.png", { animations: "disabled" });
});

test("plugin marketplace and skills catalogue layout baselines", async ({ page }) => {
  await page.addInitScript(() => {
    window.__WEBUI_FIXTURE_SETUP__ ??= [];
    window.__WEBUI_FIXTURE_SETUP__.push(() => {
      window.__fixture.setPluginManagementResult("listMarketplacePlugins", {
        pluginTotal: 2,
        plugins: [
          { name: "calendar-tools", displayName: "Calendar tools", description: "Manage a synthetic calendar" },
          { name: "local-search", displayName: "Local search", description: "Search synthetic workspace notes" },
        ],
      });
      window.__fixture.setPluginManagementResult("listInstalledPlugins", { plugins: [] });
      window.__fixture.setPluginManagementResult("listSkillHub", {
        skills: [
          { name: "release-notes", displayName: "Release notes", description: "Prepare a release summary", url: "https://example.invalid/release-notes" },
          { name: "test-plan", displayName: "Test plan", description: "Outline a synthetic test plan", url: "https://example.invalid/test-plan" },
        ],
      });
    });
  });
  await openApp(page, "#session=A");
  await page.getByRole("button", { name: "插件" }).first().click();

  const surface = page.getByTestId("plugin-management");
  const pluginGrid = surface.locator(".webui-plugin-grid");
  await expect(pluginGrid.locator(".webui-plugin-row")).toHaveCount(2);
  const grid = await pluginGrid.evaluate((node) => getComputedStyle(node).gridTemplateColumns.split(" ").length);
  expect(grid).toBe(2);
  await assertInViewport(pluginGrid, page);
  await expect(surface).toHaveScreenshot("plugin-marketplace.png", { animations: "disabled" });

  await surface.getByRole("button", { name: "技能", exact: true }).click();
  await expect(surface.locator(".webui-plugin-grid .webui-plugin-row")).toHaveCount(2);
  await expect(surface.getByText("Release notes")).toBeVisible();
  await expect(surface).toHaveScreenshot("skill-marketplace.png", { animations: "disabled" });
});

test("plugin management skill and MCP rows layout baselines", async ({ page }) => {
  await page.addInitScript(() => {
    window.__WEBUI_FIXTURE_SETUP__ ??= [];
    window.__WEBUI_FIXTURE_SETUP__.push(() => {
      window.__fixture.setPluginManagementResult("listManageableSkills", {
        skills: [
          { name: "local-checklist", displayName: "Local checklist", description: "A synthetic skill", enabled: true, locationUri: "file:///tmp/local-checklist" },
          { name: "disabled-review", displayName: "Disabled review", description: "A disabled synthetic skill", enabled: false, locationUri: "file:///tmp/disabled-review" },
        ],
      });
      window.__fixture.setPluginManagementResult("listMcpServers", {
        servers: [
          { name: "local-http", transport: "http", enabled: true, status: "available", available: true },
          { name: "missing-binary", transport: "stdio", enabled: false, status: "unavailable", available: false, error: "MCP_COMMAND_NOT_FOUND: synthetic" },
        ],
      });
    });
  });
  await openApp(page, "#session=A");
  await page.getByRole("button", { name: "插件" }).first().click();
  await page.locator(".webui-plugin-manage-trigger").click();

  const surface = page.getByTestId("plugin-management");
  await surface.locator('.webui-plugin-category-filter button', { hasText: "技能" }).click();
  await expect(surface.getByText("Local checklist")).toBeVisible();
  await expect(surface.getByLabel("启用 disabled-review")).toBeVisible();
  await assertInViewport(surface.locator(".webui-plugin-list"), page);
  await expect(surface).toHaveScreenshot("skill-management.png", { animations: "disabled" });

  await surface.locator('.webui-plugin-category-filter button', { hasText: "MCP" }).click();
  await expect(surface.getByText("已连接")).toBeVisible();
  await expect(surface.getByText("MCP_COMMAND_NOT_FOUND: synthetic")).toBeVisible();
  await expect(surface).toHaveScreenshot("mcp-management.png", { animations: "disabled" });
});
