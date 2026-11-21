// The user menu's shutdown request, end to end against the built client.
//
// Stopping the server is the one action the page cannot take back, so the
// item asks first: the confirmation is what the person answers, and the
// request is what the answer asks for.
//
// Requests in this browser spec are intercepted; actual process exit is
// exercised by the isolated development-entry integration test.

import { expect } from "@playwright/test";

import { openApp, test } from "./harness.mjs";

test("the user menu asks before it stops the server", async ({ page }) => {
  await openApp(page);

  // The rail has two triggers for the same menu: the expanded row and the
  // collapsed icon. Which one is rendered is the viewport's business, so the
  // spec takes whichever is there.
  await page
    .locator(
      '[data-testid="sidebar-user-menu-trigger"], [data-testid="sidebar-user-menu-trigger-rail"]',
    )
    .first()
    .click();
  await page.locator('[data-testid="user-menu-shutdown"]').click();

  await expect(page.getByRole("alertdialog")).toBeVisible();
  await expect(page.getByText("关闭本地 WebUI 服务")).toBeVisible();
});

test("the shutdown confirmation dismisses on a backdrop click by default", async ({ page }) => {
  await openApp(page);
  await page.locator('[data-testid="sidebar-user-menu-trigger"], [data-testid="sidebar-user-menu-trigger-rail"]').first().click();
  await page.getByTestId("user-menu-shutdown").click();
  const dialog = page.getByRole("alertdialog");
  await expect(dialog).toBeVisible();
  await page.locator('[data-webui-dialog-scrim="true"]').click({ position: { x: 8, y: 8 } });
  await expect(dialog).toHaveCount(0);
});

test("a pending shutdown keeps the dialog open, then closes after acknowledgement", async ({ page }) => {
  let release;
  const pending = new Promise((resolve) => { release = resolve; });
  await page.route("**/webui-shutdown?*", async (route) => {
    await pending;
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true, closing: true }) });
  });
  await openApp(page);
  await page.locator('[data-testid="sidebar-user-menu-trigger"], [data-testid="sidebar-user-menu-trigger-rail"]').first().click();
  await page.getByTestId("user-menu-shutdown").click();
  const dialog = page.getByRole("alertdialog");
  await dialog.getByRole("button", { name: "关闭服务", exact: true }).click();
  await expect(dialog.getByRole("button", { name: "取消", exact: true })).toBeDisabled();
  await page.locator('[data-webui-dialog-scrim="true"]').click({ position: { x: 8, y: 8 } });
  await page.keyboard.press("Escape");
  await expect(dialog).toBeVisible();
  release();
  await expect(dialog).toHaveCount(0);
  await page.screenshot({ path: test.info().outputPath("shutdown-acknowledged.png"), animations: "disabled" });
});

test("a refused shutdown can be dismissed by clicking outside after the error", async ({ page }) => {
  await page.route("**/webui-shutdown?*", (route) => route.fulfill({ status: 404, body: "Not Found" }));
  await openApp(page);
  await page.locator('[data-testid="sidebar-user-menu-trigger"], [data-testid="sidebar-user-menu-trigger-rail"]').first().click();
  await page.getByTestId("user-menu-shutdown").click();
  const dialog = page.getByRole("alertdialog");
  await dialog.getByRole("button", { name: "关闭服务", exact: true }).click();
  await expect(dialog).toContainText("当前 WebUI 不支持关闭服务。");
  await page.locator('[data-webui-dialog-scrim="true"]').click({ position: { x: 8, y: 8 } });
  await expect(dialog).toHaveCount(0);
});

test("a failed shutdown transport is unconfirmed even when the backend is still up; retry is manual", async ({ page }) => {
  let posts = 0;
  await page.route("**/webui-shutdown?*", (route) => {
    expect(route.request().method()).toBe("POST");
    posts += 1;
    return posts === 1
      ? route.abort("connectionrefused")
      : route.fulfill({ json: { ok: true, closing: true } });
  });
  await openApp(page);
  await page.locator('[data-testid="sidebar-user-menu-trigger"], [data-testid="sidebar-user-menu-trigger-rail"]').first().click();
  await page.getByTestId("user-menu-shutdown").click();
  const dialog = page.getByRole("alertdialog");
  const confirm = dialog.getByRole("button", { name: "关闭服务", exact: true });
  await confirm.click();

  await expect(dialog).toContainText("未收到关闭确认，无法确定服务是否已停止。");
  await expect(confirm).toBeEnabled();
  const health = await page.request.get("/health");
  expect(health.ok()).toBe(true);
  expect((await health.json()).status).toBe("ok");
  expect(posts).toBe(1);

  await confirm.click();
  await expect(dialog).toHaveCount(0);
  expect(posts).toBe(2);
});

for (const [label, status] of [["2xx without the receipt", 200], ["gateway timeout", 504]]) {
  test(`${label} cannot dismiss the confirmation`, async ({ page }) => {
    await page.route("**/webui-shutdown?*", (route) => route.fulfill({
      status, json: { ok: true, closing: false },
    }));
    await openApp(page);
    await page.locator('[data-testid="sidebar-user-menu-trigger"], [data-testid="sidebar-user-menu-trigger-rail"]').first().click();
    await page.getByTestId("user-menu-shutdown").click();
    const dialog = page.getByRole("alertdialog");
    await dialog.getByRole("button", { name: "关闭服务", exact: true }).click();
    await expect(dialog).toContainText("未收到关闭确认，无法确定服务是否已停止。");
  });
}

test("no shutdown response releases the dialog at the receipt deadline", async ({ page }) => {
  let release;
  const pending = new Promise((resolve) => { release = resolve; });
  await page.route("**/webui-shutdown?*", async (route) => {
    await pending;
    await route.abort().catch(() => {});
  });
  try {
    await openApp(page);
    await page.locator('[data-testid="sidebar-user-menu-trigger"], [data-testid="sidebar-user-menu-trigger-rail"]').first().click();
    await page.getByTestId("user-menu-shutdown").click();
    const dialog = page.getByRole("alertdialog");
    const confirm = dialog.getByRole("button", { name: "关闭服务", exact: true });
    await confirm.click();
    await expect(confirm).toBeDisabled();
    await expect(dialog).toContainText("未收到关闭确认，无法确定服务是否已停止。", { timeout: 10_000 });
    await expect(confirm).toBeEnabled();
  } finally {
    release();
  }
});
