// The account login page, end to end against the built client.
//
// Roadmap N (登录与账号): the WebUI had no login at all — it served whatever
// credential the terminal client had written, its usage panel said 登录后查看用量
// with no way to log in, and 退出登录 never removed the credential, so
// neither signing in nor switching accounts was possible without leaving the
// browser. This spec walks both entries and the full device-authorization
// round trip:
//
//   1. the user menu's 账号与登录 item opens the login page — the Desktop's
//      own page — and its 登录 action starts the device flow, opens the
//      authorization page in a tab and waits for the human;
//   2. the page flips to its signed-in state when the server observes the
//      credential (the fixture's setAccountLoginState stands in for the human
//      authorizing);
//   3. the user menu's 切换账号 item opens the same page in switch mode,
//      which signs the current account out before offering a sign-in;
//   4. the usage panel's signed-out block carries a 登录 button that opens
//      the same page.
//
// Boundary, stated once: the fixture's login operations are synthetic — the
// real credential round trip needs a logged-out live server and a human at
// the authorization page. What is assertable here is the browser half: every
// entry opens the surface, every phase renders its contract, and the switch
// path issues the sign-out before it offers a sign-in.

import { expect } from "@playwright/test";

import { openApp, test } from "./harness.mjs";

test.beforeEach(async ({ page }) => {
  page.on("pageerror", (error) => console.error("BROWSER_PAGE_ERROR", error.stack ?? error.message));
  page.on("console", (message) => { if (message.type() === "error") console.error("BROWSER_CONSOLE_ERROR", message.text()); });
});

const loginPage = (page) => page.locator('[data-testid="account-login-page"]');

async function openFromUserMenu(page, testId) {
  await page.locator('[data-testid="sidebar-user-menu-trigger"]').click();
  await page.locator(`[data-testid="${testId}"]`).click();
  await expect(loginPage(page)).toBeVisible();
}

test("the user menu opens the login page, and 登录 starts the device flow", async ({ page }) => {
  await openApp(page, "#session=A");
  await openFromUserMenu(page, "user-menu-account-login");

  // The page rests in the signed-out state and offers the sign-in.
  await expect(loginPage(page)).toHaveAttribute("data-webui-account-login-phase", "signed-out");
  await expect(page.locator('[data-testid="account-login-sign-in"]')).toBeVisible();

  // The sign-in starts the flow; the code arrives and the page waits for the
  // authorization, offering the link to the page it has to be entered on.
  await page.context().route("https://example.invalid/**", (route) =>
    route.fulfill({ status: 200, contentType: "text/html", body: "Synthetic authorization page" }),
  );
  const authorizationPopupPromise = page.waitForEvent("popup");
  await page.locator('[data-testid="account-login-sign-in"]').click();
  const authorizationPopup = await authorizationPopupPromise;
  await expect(authorizationPopup).toHaveURL("https://example.invalid/device?code=TEST-CODE");
  await expect(loginPage(page)).toHaveAttribute("data-webui-account-login-phase", "awaiting", { timeout: 6_000 });
  await expect(page.locator('[data-testid="account-login-copy-link"]')).toBeVisible();
  await expect(page.locator('[data-testid="account-login-cancel"]')).toBeVisible();

  // The human authorizes on the other page; the server (here: the fixture)
  // observes the credential and the poll flips the page.
  await page.evaluate(() =>
    window.__fixture.setAccountLoginState({ state: "authenticated" }),
  );
  await expect(loginPage(page)).toHaveAttribute("data-webui-account-login-phase", "authenticated", { timeout: 6_000 });
  await expect(page.locator('[data-testid="account-login-status"]')).toContainText("已登录");
});

test("切换账号 signs the current account out before offering a sign-in", async ({ page }) => {
  await openApp(page, "#session=A");
  await page.evaluate(() =>
    window.__fixture.setAccountLoginState({ state: "authenticated" }),
  );

  const signOutCount = () =>
    page.evaluate(() => window.__fixture.requests.filter((r) => r.operation === "signOut").length);
  const before = await signOutCount();

  await openFromUserMenu(page, "user-menu-switch-account");

  // The switch is a real sign-out — the operation that removes the
  // credential — and the page then offers the sign-in the Desktop's login
  // window offers.
  await expect.poll(signOutCount, { timeout: 6_000 }).toBe(before + 1);
  await expect(loginPage(page)).toHaveAttribute("data-webui-account-login-phase", "signed-out", { timeout: 6_000 });
});

test("the signed-out usage block carries a 登录 button into the same page", async ({ page }) => {
  await openApp(page, "#session=A");
  await page.evaluate(() => window.__fixture.setUsageQuotaResult({ signedIn: false }));
  await page.locator('[data-testid="sidebar-user-menu-trigger"]').click();
  await page.locator('[data-testid="user-menu-usage"]').click();
  const signIn = page.locator('[data-testid="usage-sign-in-button"]');
  await expect(signIn).toBeVisible();
  await signIn.click();
  await expect(loginPage(page)).toBeVisible();
  await expect(loginPage(page)).toHaveAttribute("data-webui-account-login-phase", "signed-out");
});

test("the legal notice names the account's own documents", async ({ page }) => {
  await openApp(page, "#session=A");
  await openFromUserMenu(page, "user-menu-switch-account");

  // The account scope travels with the handshake, and the scope decides the
  // account's site and the language its documents are published in.
  const terms = page.locator('[data-testid="account-login-terms"]');
  await expect(terms).toHaveAttribute(
    "href",
    "https://agent.minimax.cn/doc/zh/terms-of-service.html",
  );
  await expect(page.locator('[data-testid="account-login-privacy"]')).toHaveAttribute(
    "href",
    "https://agent.minimax.cn/doc/zh/privacy-policy.html",
  );
});

test("取消登录 cancels the in-flight attempt", async ({ page }) => {
  await openApp(page, "#session=A");
  await openFromUserMenu(page, "user-menu-account-login");
  await page.locator('[data-testid="account-login-sign-in"]').click();
  await expect(loginPage(page)).toHaveAttribute("data-webui-account-login-phase", "awaiting", { timeout: 6_000 });

  await page.locator('[data-testid="account-login-cancel"]').click();
  await expect.poll(() =>
    page.evaluate(() => window.__fixture.requests.some((r) => r.operation === "cancelAccountLogin")),
  ).toBe(true);
});
