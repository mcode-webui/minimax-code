import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { expect } from "@playwright/test";

import { openApp, screenshotOptions, test } from "./harness.mjs";

test("marketplace groups and filters Mini Apps from the returned tags", async ({ page }) => {
  await page.addInitScript(() => {
    window.__WEBUI_FIXTURE_SETUP__ ??= [];
    window.__WEBUI_FIXTURE_SETUP__.push(() => {
      window.__fixture.setPluginManagementResult("listMarketplacePlugins", {
        pluginTotal: 2,
        tagDefinitions: [{ key: "miniapp", displayName: "Mini App" }],
        plugins: [
          { name: "board", displayName: "Board", tags: [{ key: "miniapp", displayName: "Mini App" }] },
          { name: "other", displayName: "Other" },
        ],
      });
      window.__fixture.setPluginManagementResult("listInstalledPlugins", { plugins: [] });
    });
  });
  await openApp(page, "#session=A");
  await page.getByRole("button", { name: "插件" }).first().click();
  const group = page.getByRole("region", { name: "Mini App" });
  await expect(group).toContainText("Board");
  await expect(group).not.toContainText("Other");
  await page.getByRole("navigation", { name: "市场分类" }).getByRole("button", { name: "Mini App" }).click();
  await expect(page.locator(".webui-plugin-grid")).toContainText("Board");
  await expect(page.locator(".webui-plugin-grid")).not.toContainText("Other");
  await page.locator(".webui-plugin-grid").getByRole("button", { name: "安装" }).click();
  await expect.poll(() => page.evaluate(() => window.__fixture.requests.some((entry) =>
    entry.operation === "pluginManagement" && entry.body.action === "installPlugin" && entry.body.input?.pluginName === "board"))).toBe(true);
});

async function openManagement(page) {
  await openApp(page, "#session=A");
  await page.getByRole("button", { name: "插件" }).first().click();
  await page.getByTestId("plugin-manage-trigger").click();
  await page.getByTestId("plugin-create-trigger").click();
}

async function expectCenteredDialog(dialog, page, fieldsSelector, expectedFieldsDisplay = "grid") {
  await expect(dialog).toBeVisible();
  await expect(dialog).toHaveAttribute("aria-modal", "true");
  await dialog.evaluate((node) => Promise.all(node.getAnimations({ subtree: true }).map((animation) => animation.finished)));
  const geometry = await dialog.evaluate((node, fieldsSelector) => {
    const backdrop = node.parentElement;
    const backdropBox = backdrop.getBoundingClientRect();
    const rect = node.getBoundingClientRect();
    const fields = fieldsSelector ? node.querySelector(fieldsSelector) : null;
    const fieldsStyle = fields ? getComputedStyle(fields) : null;
    return {
      backdropFixed: getComputedStyle(backdrop).position === "fixed",
      backdropCoversViewport: backdropBox.left <= 0 && backdropBox.top <= 0 &&
        backdropBox.right >= innerWidth && backdropBox.bottom >= innerHeight,
      centered: Math.abs(rect.left + rect.width / 2 - innerWidth / 2) < 3 &&
        Math.abs(rect.top + rect.height / 2 - innerHeight / 2) < 3,
      insideViewport: rect.left >= 0 && rect.top >= 0 &&
        rect.right <= innerWidth && rect.bottom <= innerHeight,
      fieldsDisplay: fieldsStyle?.display,
    };
  }, fieldsSelector);
  expect(geometry, JSON.stringify(geometry)).toMatchObject({
    backdropFixed: true,
    backdropCoversViewport: true,
    centered: true,
    insideViewport: true,
    ...(fieldsSelector ? { fieldsDisplay: expectedFieldsDisplay } : {}),
  });
  await expect(page.locator('[data-webui-dialog-scrim="true"]')).toHaveScreenshot(screenshotOptions);
}

async function expectMobileDialog(dialog, page, fieldsSelector) {
  await page.setViewportSize({ width: 390, height: 844 });
  // The dialog's form follows the dialog's own width, not the width of the
  // window (ADR 0025). The single-column assertion below is what proves the
  // narrow tier is in force; there is no viewport breakpoint left to match.
  await expect.poll(() => dialog.evaluate((node) => node.getBoundingClientRect().width)).toBeLessThan(390);
  const layout = await dialog.evaluate((node, fieldsSelector) => {
    const rect = node.getBoundingClientRect();
    const fields = node.querySelector(fieldsSelector);
    const style = getComputedStyle(fields);
    return {
      withinViewport: rect.left >= 0 && rect.right <= innerWidth && rect.top >= 0 && rect.bottom <= innerHeight,
      noHorizontalOverflow: node.scrollWidth <= node.clientWidth,
      singleColumn: style.gridTemplateColumns.split(" ").filter(Boolean).length === 1,
      controlsHaveReadableWidth: [...fields.querySelectorAll("input:not([type=checkbox]), select, textarea")]
        .every((control) => control.getBoundingClientRect().width >= 280),
      rect: { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, width: rect.width, height: rect.height },
      viewport: { width: innerWidth, height: innerHeight },
    };
  }, fieldsSelector);
  expect(layout, JSON.stringify(layout)).toMatchObject({
    withinViewport: true,
    noHorizontalOverflow: true,
    singleColumn: true,
    controlsHaveReadableWidth: true,
  });
}

test("plugin marketplace keeps its card grid and expand/collapse count", async ({ page }, testInfo) => {
  await page.addInitScript(() => {
    window.__WEBUI_FIXTURE_SETUP__ ??= [];
    window.__WEBUI_FIXTURE_SETUP__.push(() => {
      window.__fixture.setPluginManagementResult("listMarketplacePlugins", {
        pluginTotal: 10,
        plugins: Array.from({ length: 10 }, (_, index) => ({
          name: `market-plugin-${index + 1}`,
          displayName: `Market plugin ${index + 1}`,
          description: "Marketplace card",
        })),
      });
      window.__fixture.setPluginManagementResult("listInstalledPlugins", {
        plugins: [],
      });
    });
  });

  await openApp(page, "#session=A");
  await page.getByRole("button", { name: "插件" }).first().click();

  const cards = page.locator(".webui-plugin-grid .webui-plugin-row");
  await expect(cards).toHaveCount(10);
  await expect(page.getByRole("heading", { name: "插件" }).last()).toBeVisible();

  const captureDir = process.env.WEBUI_DECOMPOSITION_SCREENSHOT_DIR;
  if (captureDir) {
    mkdirSync(captureDir, { recursive: true });
    await page.screenshot({
      path: join(captureDir, "d06-plugin-market-expanded.png"),
      fullPage: true,
    });
  }

  await page.getByRole("button", { name: "收起插件" }).click();
  await expect(cards).toHaveCount(8);
  await expect(page.getByRole("button", { name: "查看全部 10 个" })).toBeVisible();
  if (captureDir) {
    await page.screenshot({
      path: join(captureDir, "d06-plugin-market-collapsed.png"),
      fullPage: true,
    });
  }

  await page.getByRole("button", { name: "查看全部 10 个" }).click();
  await expect(cards).toHaveCount(10);
});

test("Skill add form is centered, usable and submits through plugin management", async ({ page }) => {
  await page.addInitScript(() => {
    window.__WEBUI_FIXTURE_SETUP__ ??= [];
    window.__WEBUI_FIXTURE_SETUP__.push(() => {
      window.__fixture.setPluginManagementResult("listManageableSkills", { skills: [] });
      window.__fixture.setPluginManagementResult("createSkill", { success: true });
    });
  });
  await openManagement(page);
  await page.getByRole("menuitem", { name: "录入技能" }).click();
  const dialog = page.getByRole("dialog", { name: "技能" });
  await expectCenteredDialog(dialog, page, ".webui-skill-form");
  await expectMobileDialog(dialog, page, ".webui-skill-form");
  await dialog.getByLabel("名称").fill("local-checklist");
  await dialog.getByLabel("描述").fill("Synthetic workflow skill");
  await dialog.getByLabel("内容").fill("Check the local workflow.");
  await dialog.getByRole("button", { name: "保存" }).click();
  await expect.poll(() => page.evaluate(() => window.__fixture.requests.some((request) =>
    request.operation === "pluginManagement" && request.body.action === "createSkill",
  ))).toBe(true);
  const request = await page.evaluate(() => window.__fixture.requests.find((entry) =>
    entry.operation === "pluginManagement" && entry.body.action === "createSkill",
  ));
  expect(request.body.input).toMatchObject({
    name: "local-checklist",
    description: "Synthetic workflow skill",
    content: "Check the local workflow.",
  });
  await expect(dialog).toHaveCount(0);
});

test("Agent add form is centered, fields are aligned and backdrop dismissal works", async ({ page }) => {
  await page.addInitScript(() => {
    window.__WEBUI_FIXTURE_SETUP__ ??= [];
    window.__WEBUI_FIXTURE_SETUP__.push(() => {
      window.__fixture.setPluginManagementResult("listAgents", { agents: [] });
      window.__fixture.setPluginManagementResult("createAgent", { success: true });
    });
  });
  await openManagement(page);
  // The create menu mounts in an effect after its trigger is clicked, so the
  // entry can still be missing a moment later — and "创建 Agent" is also the
  // name of a button of its own on the agent list, which this same page shows
  // once an agent form has been opened. The query is scoped to the menu and
  // waits for the entry, so the click lands on the menu entry and never on
  // whatever else happens to carry the same name.
  const createMenu = page.getByRole("menu", { name: "创建" });
  const createAgent = createMenu.getByRole("menuitem", { name: "创建 Agent" });
  await expect(createAgent).toBeVisible();
  await createAgent.click();
  const dialog = page.getByRole("dialog", { name: "Agent" });
  await expectCenteredDialog(dialog, page, ".webui-agent-form");
  await expectMobileDialog(dialog, page, ".webui-agent-form");
  const alignment = await dialog.evaluate((node) => {
    const labels = [...node.querySelectorAll(".webui-agent-form label")];
    // The field contract owns the label, so a label no longer wraps its
    // control: the control is the field's own child, and the label is its
    // sibling. The assertion is about the control's box, so it reads the
    // controls directly.
    const controls = [...node.querySelectorAll(".webui-agent-form input, .webui-agent-form textarea")];
    const labelBoxes = labels.map((label) => label.getBoundingClientRect());
    const prompt = node.querySelector("textarea").getBoundingClientRect();
    return {
      labelCount: labels.length,
      promptHasWidth: prompt.width >= 280,
      promptWidth: prompt.width,
      formColumns: getComputedStyle(node.querySelector(".webui-agent-form")).gridTemplateColumns,
      dialogWidth: node.getBoundingClientRect().width,
      labelInputsHaveUsableHeight: controls.every(
        (control) => control.getBoundingClientRect().height >= 40,
      ),
      noHorizontalOverflow: node.scrollWidth <= node.clientWidth,
      labelBoxesInDialog: labelBoxes.every((box) => box.left >= node.getBoundingClientRect().left && box.right <= node.getBoundingClientRect().right),
    };
  });
  expect(alignment, JSON.stringify(alignment)).toMatchObject({ labelCount: 4, promptHasWidth: true, labelInputsHaveUsableHeight: true, noHorizontalOverflow: true, labelBoxesInDialog: true });
  await page.locator('[data-webui-dialog-scrim="true"]').click({ position: { x: 5, y: 5 } });
  await expect(dialog).toHaveCount(0);

  await page.getByTestId("plugin-create-trigger").click();
  await expect(createAgent).toBeVisible();
  await createAgent.click();
  const reopened = page.getByRole("dialog", { name: "Agent" });
  await reopened.getByLabel("名称").fill("local-agent");
  await reopened.getByLabel("描述").fill("A synthetic local agent");
  await reopened.getByLabel("系统提示词").fill("Use only the local test workspace.");
  await reopened.getByLabel("模型").fill("stub-model");
  await reopened.getByRole("button", { name: "保存" }).click();
  await expect.poll(() => page.evaluate(() => window.__fixture.requests.some((request) =>
    request.operation === "pluginManagement" && request.body.action === "createAgent",
  ))).toBe(true);
  const request = await page.evaluate(() => window.__fixture.requests.find((entry) =>
    entry.operation === "pluginManagement" && entry.body.action === "createAgent",
  ));
  expect(request.body.input).toMatchObject({
    name: "local-agent",
    description: "A synthetic local agent",
    systemPrompt: "Use only the local test workspace.",
    initialDefinition: { model: "stub-model" },
  });
  await expect(reopened).toHaveCount(0);
});

test("MCP add form validates inputs, switches transport and sends advanced HTTP config", async ({ page }) => {
  await page.addInitScript(() => {
    window.__WEBUI_FIXTURE_SETUP__ ??= [];
    window.__WEBUI_FIXTURE_SETUP__.push(() => {
      window.__fixture.setPluginManagementResult("listMcpServers", { servers: [] });
      window.__fixture.setPluginManagementResult("createMcpServer", { success: true });
    });
  });
  await openManagement(page);
  await page.getByRole("menuitem", { name: "添加 MCP server" }).click();
  const dialog = page.getByRole("dialog", { name: "MCP Server" });
  await expectCenteredDialog(dialog, page, ".webui-mcp-form-fields");
  await expect(dialog.getByRole("switch", { name: "启用 MCP server" })).toBeChecked();
  await expectMobileDialog(dialog, page, ".webui-mcp-form-fields");

  await dialog.getByLabel("名称").fill("local-docs");
  await dialog.getByLabel("传输方式").selectOption("http");
  await expect(dialog.getByLabel("地址")).toBeVisible();
  await expect(dialog.getByLabel("命令")).toHaveCount(0);
  await dialog.getByLabel("地址").fill("http://127.0.0.1:43121/mcp");
  await dialog.getByRole("button", { name: "高级" }).click();
  await dialog.getByLabel("请求头").fill('{"x-test":"synthetic"}');
  await dialog.getByLabel("超时（毫秒）").fill("0");
  // The Desktop dialog disables its primary action while the form is invalid,
  // so the invalid state is asserted on the control: a disabled action cannot be
  // pressed and cannot send a request.
  await expect(dialog.getByRole("button", { name: "添加服务器" })).toBeDisabled();
  // A disabled action cannot be pressed, so the invalid value is refused before
  // any request exists. The 正整数 message `buildRequest` throws for the same
  // value stays a defensive check behind `canSave`, not a user-facing path.
  await expect.poll(() => page.evaluate(() => window.__fixture.requests.some((request) =>
    request.operation === "pluginManagement" && request.body.action === "createMcpServer",
  ))).toBe(false);

  await dialog.getByLabel("超时（毫秒）").fill("1500");
  await expect(dialog.getByRole("button", { name: "添加服务器" })).toBeEnabled();
  await dialog.getByRole("button", { name: "添加服务器" }).click();
  await expect.poll(() => page.evaluate(() => window.__fixture.requests.some((request) =>
    request.operation === "pluginManagement" && request.body.action === "createMcpServer",
  ))).toBe(true);
  const request = await page.evaluate(() => window.__fixture.requests.find((entry) =>
    entry.operation === "pluginManagement" && entry.body.action === "createMcpServer",
  ));
  expect(request.body.input).toMatchObject({
    name: "local-docs",
    enabled: true,
    config: {
      transport: "http",
      url: "http://127.0.0.1:43121/mcp",
      headers: { "x-test": "synthetic" },
      timeoutMs: 1500,
    },
  });
  await expect(dialog).toHaveCount(0);
});

test("Git plugin import form is an accessible viewport overlay and previews local fixture data", async ({ page }) => {
  await page.addInitScript(() => {
    window.__WEBUI_FIXTURE_SETUP__ ??= [];
    window.__WEBUI_FIXTURE_SETUP__.push(() => {
      window.__fixture.setPluginManagementResult("previewGithubPlugin", {
        canImport: true,
        plugin: { summary: { name: "local-plugin", displayName: "Local plugin" } },
      });
    });
  });
  await openManagement(page);
  await page.getByRole("menuitem", { name: "从 Git 仓库导入插件" }).click();
  const dialog = page.getByRole("dialog", { name: "从 Git 仓库导入插件" });
  await expectCenteredDialog(dialog, page, ".webui-plugin-import-body", "block");
  await expectMobileDialog(dialog, page, ".webui-plugin-import-body");
  await dialog.getByRole("textbox", { name: "仓库 URL" }).fill("https://github.com/example/local-plugin");
  await dialog.getByRole("button", { name: "预览" }).click();
  await expect(dialog.getByText("Local plugin")).toBeVisible();
  await expect.poll(() => page.evaluate(() => window.__fixture.requests.some((request) =>
    request.operation === "pluginManagement" && request.body.action === "previewGithubPlugin",
  ))).toBe(true);
});
