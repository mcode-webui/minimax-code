// The account login dialog, end to end against the built client.
//
// Roadmap N (登录与账号): the WebUI had no login at all — it served whatever
// credential the terminal client had written, its usage panel said 登录后查看用量
// with no way to log in, and 退出登录 never removed the credential, so
// neither signing in nor switching accounts was possible without leaving the
// browser. This spec walks both entries and the full device-authorization
// round trip:
//
//   1. the user menu's 账号与登录 item opens the dialog, which shows the
//      device code and the authorization link, then flips to authenticated
//      when the server observes the credential (the fixture's
//      setAccountLoginState stands in for the human authorizing);
//   2. from the authenticated state, 切换账号 signs out and starts a fresh
//      device flow in the same surface — the whole of account switching
//      under a single-credential store;
//   3. the usage panel's signed-out block carries a 登录 button that opens
//      the same dialog.
//
// Boundary, stated once: the fixture's login operations are synthetic — the
// real credential round trip needs a logged-out live server and a human at
// the authorization page. What is assertable here is the browser half: every
// entry opens the surface, every phase renders its contract, and the switch
// path issues the sign-out before the new device flow.

import { expect } from "@playwright/test";

import { openApp, test } from "./harness.mjs";

test.beforeEach(async ({ page }) => {
  page.on("pageerror", (error) => console.error("BROWSER_PAGE_ERROR", error.stack ?? error.message));
  page.on("console", (message) => { if (message.type() === "error") console.error("BROWSER_CONSOLE_ERROR", message.text()); });
});

const dialog = (page) => page.locator('[data-testid="account-login-dialog"]');

async function openFromUserMenu(page) {
  await page.locator('[data-testid="sidebar-user-menu-trigger"]').click();
  await page.locator('[data-testid="user-menu-account-login"]').click();
  await expect(dialog(page)).toBeVisible();
}

test("the user menu opens the login, and authorization completes the flow", async ({ page }) => {
  await openApp(page, "#session=A");
  await openFromUserMenu(page);

  // The device prompt: the code the user enters and the page to enter it on.
  await expect(dialog(page)).toHaveAttribute("data-webui-account-login-phase", "pending");
  await expect(page.locator('[data-testid="account-login-code"]')).toHaveText("TEST-CODE");
  await expect(page.locator('[data-testid="account-login-uri"]')).toHaveAttribute(
    "href",
    "https://example.invalid/device?code=TEST-CODE",
  );

  // The human authorizes on the other page; the server (here: the fixture)
  // observes the credential and the poll flips the dialog.
  await page.evaluate(() =>
    window.__fixture.setAccountLoginState({ state: "authenticated" }),
  );
  await expect(dialog(page)).toHaveAttribute("data-webui-account-login-phase", "authenticated", { timeout: 6_000 });
  await expect(page.locator('[data-testid="account-login-status"]')).toContainText("已登录");
});

test("切换账号 signs out first, then starts a fresh device flow", async ({ page }) => {
  await openApp(page, "#session=A");
  await openFromUserMenu(page);
  await page.evaluate(() =>
    window.__fixture.setAccountLoginState({ state: "authenticated" }),
  );
  await expect(dialog(page)).toHaveAttribute("data-webui-account-login-phase", "authenticated", { timeout: 6_000 });

  const signOutCount = () =>
    page.evaluate(() => window.__fixture.requests.filter((r) => r.operation === "signOut").length);
  const before = await signOutCount();
  await page.locator('[data-testid="account-login-switch"]').click();

  // The switch is a real sign-out (the operation that now removes the
  // credential) followed by a new device prompt in the same dialog.
  await expect.poll(signOutCount, { timeout: 6_000 }).toBe(before + 1);
  await expect(dialog(page)).toHaveAttribute("data-webui-account-login-phase", "pending", { timeout: 6_000 });
  await expect(page.locator('[data-testid="account-login-code"]')).toHaveText("TEST-CODE");
});

test("the signed-out usage block carries a 登录 button into the same dialog", async ({ page }) => {
  await openApp(page, "#session=A");
  await page.evaluate(() => window.__fixture.setUsageQuotaResult({ signedIn: false }));
  await page.locator('[data-testid="sidebar-user-menu-trigger"]').click();
  await page.locator('[data-testid="user-menu-usage"]').click();
  const signIn = page.locator('[data-testid="usage-sign-in-button"]');
  await expect(signIn).toBeVisible();
  await signIn.click();
  await expect(dialog(page)).toBeVisible();
  await expect(page.locator('[data-testid="account-login-code"]')).toHaveText("TEST-CODE");
});

test("取消 closes the dialog and cancels the in-flight attempt", async ({ page }) => {
  await openApp(page, "#session=A");
  await openFromUserMenu(page);
  await expect(page.locator('[data-testid="account-login-code"]')).toHaveText("TEST-CODE");

  await page.locator('[data-testid="account-login-cancel"]').click();
  await expect(dialog(page)).toHaveCount(0);
  await expect.poll(() =>
    page.evaluate(() => window.__fixture.requests.some((r) => r.operation === "cancelAccountLogin")),
  ).toBe(true);
});
