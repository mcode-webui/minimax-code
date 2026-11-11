// The feedback family on the surfaces that adopted it (#292, ADR 0028 §
// Shared contracts).
//
// The contracts themselves are held by `feedback.test.ts`. What only a browser can
// show is the two things the AC asks for: that a dynamic error is announced once
// and is associated with the control it belongs to (rather than announced twice,
// or announced and then unreachable), and that a determinate bar and an
// indeterminate indicator are not the same thing on a real surface — the plugin
// panel says "busy" with a `status` and never with a `progressbar`, because it has
// no number to report.

import { expect } from "@playwright/test";

import { configureFixture, openApp, test } from "./harness.mjs";

test.beforeEach(async ({ page }) => {
  page.on("pageerror", (error) => console.error("BROWSER_PAGE_ERROR", error.stack ?? error.message));
  await configureFixture(page, () => {
    window.__fixture.setPage("A", {
      messages: [{ msgId: "history-A", role: "assistant", msgContent: "History A synthetic" }],
      hasMore: false,
      contextSnapshot: { status: "live", usage: { totalTokens: 12000, contextWindow: 200000 } },
    });
    window.__fixture.setResponse("getMemorySettings", { enabled: true, proactive: false });
    window.__fixture.setUsageQuotaResult({
      signedIn: true,
      hasTokenPlan: false,
      subscriptionType: "mplan",
      planName: "M Plan 标准版",
      quota: {
        fiveHour: { usedPercent: 87, totalPercent: 100, resetAtMs: 1_800_000_000_000, unlimited: false },
        weekly: { usedPercent: 42, totalPercent: 100, resetAtMs: 1_800_000_000_000, unlimited: false },
      },
    });
  });
  await openApp(page, "#session=A");
});

const settingsDialog = (page) => page.locator('[role="dialog"][aria-label="设置"]');

async function openSettingsPage(page, menuKey) {
  await page.getByTestId("sidebar-user-menu-trigger").click();
  await page.getByTestId("user-menu-settings").click();
  await expect(settingsDialog(page)).toBeVisible();
  await page.locator(`.webui-settings-nav [data-menu-key="${menuKey}"]`).click();
}

test("a dynamic field error is announced once and stays associated with its control", async ({ page }) => {
  await openSettingsPage(page, "usage");
  await page.getByRole("button", { name: "自定义模型" }).click();
  // The action sits in the page toolbar, outside the panel it opens the form from.
  await page.getByRole("dialog", { name: "设置" }).getByRole("button", { name: "添加模型", exact: true }).click();
  const form = page.getByRole("dialog", { name: "添加模型" });
  await expect(form).toBeVisible();

  const endpoint = form.getByLabel(/^接口地址/u);
  await endpoint.fill("not-a-url");

  // Exactly one announcement in the dialog: an error that is also copied into a
  // second live region would say the same sentence twice.
  await expect(form.getByRole("alert")).toHaveCount(1);
  const alert = form.getByRole("alert");
  await expect(alert).toHaveText(/http:\/\/ 或 https:\/\//u);

  // The announcement is not the only way to reach it: the control points at it.
  const alertId = (await alert.getAttribute("id")) ?? "";
  const describedBy = (await endpoint.getAttribute("aria-describedby")) ?? "";
  expect(alertId, "the error has an id a control can point at").toBeTruthy();
  expect(describedBy.split(" "), "the control is described by the error").toContain(alertId);
  await expect(endpoint).toHaveAttribute("aria-invalid", "true");
  // The shared dialog dismisses on backdrop clicks by default.
  await page.mouse.click(6, 6);
  await expect(form).toHaveCount(0);
  await page.getByRole("dialog", { name: "设置" }).getByRole("button", { name: "添加模型", exact: true }).click();
  await expect(form).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(form).toHaveCount(0);
});

test("a determinate bar carries a value while a busy indicator carries none", async ({ page }) => {
  // The client's one determinate progress surface: the composer's context usage
  // bar. It reports a share of a known window, so it wears `progressbar` with a
  // value; a busy indicator has no share to report and must not wear the role.
  const usage = page.getByTestId("composer-context-usage");
  await expect(usage).toBeVisible();
  await usage.click();

  const bar = page.getByRole("progressbar", { name: "上下文窗口使用量" });
  await expect(bar).toHaveCount(1);
  // This scenario supplies a known window, so it must report its exact share.
  const value = await bar.getAttribute("aria-valuenow");
  const label = await bar.getAttribute("aria-label");
  expect(label, "the bar is named").toBeTruthy();
  expect(value, "the known context window requires a determinate value").not.toBeNull();
  const numeric = Number(value);
  expect(Number.isFinite(numeric), "a value is a number").toBe(true);
  expect(numeric).toBe(6);
  await expect(bar).toHaveAttribute("aria-valuemax", "100");

  // And nothing in the composer claims to be loading a share of anything.
  await expect(page.locator('[role="status"][aria-valuenow]')).toHaveCount(0);
});

test("the usage quota bars use the shared progress transition", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await openSettingsPage(page, "usage");

  const limits = page.getByTestId("settings-usage-limits");
  await expect(limits).toBeVisible();
  const bars = limits.getByRole("progressbar");
  await expect(bars).toHaveCount(2);
  const firstBar = bars.first();
  await expect(firstBar).toHaveAttribute("aria-valuenow", "87");

  const fill = firstBar.locator(".webui-feedback-progress-fill");
  await expect(fill).toHaveClass(/webui-motion-progress/u);
  await expect.poll(() => fill.evaluate((element) => {
    const style = getComputedStyle(element);
    return { property: style.transitionProperty, duration: style.transitionDuration };
  })).toEqual({ property: "width, stroke-dashoffset", duration: "0.12s" });
});

test("the usage model-source menu uses the shared dropdown entrance and exit", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await openSettingsPage(page, "usage");

  const labelTrigger = page.getByTestId("settings-usage-source-tab");
  await labelTrigger.click();
  const menu = page.getByRole("menu", { name: "选择模型来源" });
  await expect(menu).toBeVisible();
  await expect.poll(() => menu.evaluate((element) => getComputedStyle(element).animationName))
    .toBe("webui-dropdown-in");
  await expect(menu.getByRole("menuitem")).toHaveCount(2);

  await page.keyboard.press("Escape");
  await expect(menu).toHaveClass(/is-leaving/u);
  await expect.poll(() => menu.evaluate((element) => getComputedStyle(element).animationName))
    .toBe("webui-dropdown-out");
  await expect(menu).toHaveCount(0);

  await page.getByRole("button", { name: "选择模型来源" }).click();
  const reopenedMenu = page.getByRole("menu", { name: "选择模型来源" });
  await expect(reopenedMenu).toBeVisible();
  await reopenedMenu.getByRole("menuitem", { name: "MiniMax API" }).click();
  await expect(reopenedMenu).toHaveCount(0);
  await expect(labelTrigger).toContainText("MiniMax API");
});

test("the plugin panel reports activity as a status, never as a progressbar", async ({ page }) => {
  await page.evaluate(() => window.__fixture.delayEvery("pluginManagement", { action: "listMarketplacePlugins" }));
  // The plugin area is a rail surface, not a settings page.
  await page.getByRole("button", { name: /^插件$/u }).first().click();
  const panel = page.getByTestId("plugin-management");
  await expect(panel).toBeVisible();
  await expect(panel).toHaveAttribute("aria-busy", "true");

  // Whatever the panel is doing, it has no determinate amount to report, so it must
  // not wear the progressbar role: a bar with no value tells a reader nothing.
  await expect(panel.locator('[role="progressbar"]')).toHaveCount(0);

  // A loading or empty state, when it is there, is a status or a plain state.
  const statuses = panel.locator('[role="status"]');
  await expect(statuses).toHaveCount(1);
  for (let index = 0; index < (await statuses.count()); index += 1) {
    await expect(statuses.nth(index)).not.toHaveAttribute("aria-valuenow", /.*/u);
  }

  // And when the catalogue reports a failure it is an alert, addressable and not a
  // banner: exactly one live region for it.
  await page.evaluate(() => {
    window.__fixture.refuseOperation("pluginManagement", "harness_error", "Synthetic catalogue failure");
    window.__fixture.resolve("pluginManagement", { action: "listMarketplacePlugins" }, { plugins: [], total: 0 });
  });
  await expect(panel).not.toHaveAttribute("aria-busy", "true");
  await page.getByRole("button", { name: "技能", exact: true }).first().click();
  const alert = page.getByTestId("plugin-catalogue-error");
  await expect(alert).toBeVisible();
  await expect(alert).toHaveAttribute("role", "alert");
  await expect(alert).toContainText("Synthetic catalogue failure");
  await expect(alert).toHaveCount(1);
});
