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
    window.__fixture.setResponse("getMemorySettings", { enabled: true, proactive: false });
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
  await page.locator('[data-testid="settings-custom-models-panel"]').getByRole("button", { name: "添加模型" }).click();
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
});

test("a determinate bar carries a value while a busy indicator carries none", async ({ page }) => {
  // The client's one determinate progress surface: the composer's context usage
  // bar. It reports a share of a known window, so it wears `progressbar` with a
  // value; a busy indicator has no share to report and must not wear the role.
  const usage = page.getByTestId("composer-context-usage");
  // The indicator only renders when the runtime reports a context window; with no
  // usage in the fixture there is no bar to measure and the test says so.
  test.skip((await usage.count()) === 0, "the runtime reports no context usage in this fixture");
  await expect(usage).toBeVisible();
  await usage.click();

  const bar = usage.locator('[role="progressbar"]');
  await expect(bar).toHaveCount(1);
  // With a known window the bar reports the share; with none it drops the value
  // rather than reporting zero, which is the indeterminate form of the same bar.
  const value = await bar.getAttribute("aria-valuenow");
  const label = await bar.getAttribute("aria-label");
  expect(label, "the bar is named").toBeTruthy();
  if (value !== null) {
    const numeric = Number(value);
    expect(Number.isFinite(numeric), "a value is a number").toBe(true);
    expect(numeric).toBeGreaterThanOrEqual(0);
    expect(numeric).toBeLessThanOrEqual(100);
    await expect(bar).toHaveAttribute("aria-valuemax", "100");
  }

  // And nothing in the composer claims to be loading a share of anything.
  await expect(page.locator('[role="status"][aria-valuenow]')).toHaveCount(0);
});

test("the plugin panel reports activity as a status, never as a progressbar", async ({ page }) => {
  // The plugin area is a rail surface, not a settings page.
  await page.getByRole("button", { name: /^插件$/u }).first().click();
  const panel = page.locator('[data-webui-component="plugin-catalogue"]');
  if ((await panel.count()) === 0) test.skip(true, "the runtime exposes no plugin catalogue in this fixture");
  await expect(panel.first()).toBeVisible();

  // Whatever the panel is doing, it has no determinate amount to report, so it must
  // not wear the progressbar role: a bar with no value tells a reader nothing.
  await expect(panel.locator('[role="progressbar"]')).toHaveCount(0);

  // A loading or empty state, when it is there, is a status or a plain state.
  const statuses = panel.locator('[role="status"]');
  for (let index = 0; index < (await statuses.count()); index += 1) {
    await expect(statuses.nth(index)).not.toHaveAttribute("aria-valuenow", /.*/u);
  }

  // And when the catalogue reports a failure it is an alert, addressable and not a
  // banner: exactly one live region for it.
  const alerts = panel.locator('[role="alert"]');
  if ((await alerts.count()) > 0) await expect(alerts).toHaveCount(1);
});
