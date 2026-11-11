// The account login page, end to end against the built client.
//
// Roadmap N (登录与账号): the WebUI had no login at all — it served whatever
// credential the terminal client had written, its usage panel said 登录后查看用量
// with no way to log in, and 退出登录 never removed the credential, so
// neither signing in nor switching accounts was possible without leaving the
// browser. This spec walks both entries and the full device-authorization
// round trip:
//
//   1. the user menu's 账号与登录 item opens the login page, and its 登录
//      action starts the device flow, opens the
//      authorization page in a tab and waits for the human;
//   2. the page flips to its signed-in state when the server observes the
//      credential (the fixture's setAccountLoginState stands in for the human
//      authorizing);
//   3. a signed-in page switches accounts itself: its own 切换账号 signs the
//      current account out and starts the fresh sign-in;
//   4. the usage panel's signed-out block carries a 登录 button that opens
//      the same page.
//
// Boundary, stated once: the fixture's login operations are synthetic — the
// real credential round trip needs a logged-out live server and a human at
// the authorization page. What is assertable here is the browser half: every
// entry opens the surface, every phase renders its contract, and the switch
// path issues the sign-out before it starts a new sign-in.

import { expect } from "@playwright/test";

import { configureFixture, openApp, test } from "./harness.mjs";

test.beforeEach(async ({ page }) => {
  page.on("pageerror", (error) => console.error("BROWSER_PAGE_ERROR", error.stack ?? error.message));
  page.on("console", (message) => { if (message.type() === "error") console.error("BROWSER_CONSOLE_ERROR", message.text()); });
});

for (const theme of ["light", "dark"]) {
test(`usage hover keeps the subscription label stable during refresh (${theme})`, async ({ page }) => {
  await page.addInitScript((value) => window.localStorage.setItem("webui-theme", value), theme);
  await configureFixture(page, () => window.__fixture.setUsageQuotaResult({ signedIn: true, hasTokenPlan: true, tokenPlanTier: "Explore" }));
  await openApp(page);
  const trigger = page.getByTestId("sidebar-user-menu-trigger");
  await trigger.click();
  const usage = page.getByTestId("user-menu-usage");
  await usage.hover();
  await expect(trigger.locator("small")).toHaveText("Explore");
  await trigger.evaluate((element) => {
    window.__railLabelChanges = [];
    new MutationObserver(() => window.__railLabelChanges.push(element.querySelector("small")?.textContent ?? null)).observe(element, { childList: true, subtree: true, characterData: true });
  });
  const requestsBefore = await page.evaluate(() => window.__fixture.requests.filter((r) => r.operation === "getUsageQuota").length);
  for (let index = 0; index < 12; index += 1) {
    await page.getByTestId("user-menu-settings").hover();
    await usage.hover();
  }
  expect(await page.evaluate(() => window.__fixture.requests.filter((r) => r.operation === "getUsageQuota").length)).toBe(requestsBefore);
  expect(await page.evaluate(() => window.__railLabelChanges.filter((label) => label !== "Explore"))).toEqual([]);
  await page.mouse.move(700, 150);
  await expect(page.getByTestId("usage-popover")).toHaveCount(0);
  await page.evaluate(() => window.__fixture.delayEvery("getUsageQuota", {}));
  await usage.hover();
  await expect(page.getByTestId("usage-popover-loading")).toBeVisible();
  await expect(trigger.locator("small")).toHaveText("Explore");
  await page.screenshot({ path: test.info().outputPath(`subscription-refresh-${theme}.png`), animations: "disabled" });
  await page.evaluate(() => window.__fixture.resolveAllPending("getUsageQuota", {}, { signedIn: true, hasTokenPlan: true, tokenPlanTier: "Build" }));
  await expect(trigger.locator("small")).toHaveText("Build");
});
}

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

test("the account login page completes its shared surface exit on Escape", async ({ page }) => {
  await openApp(page, "#session=A");
  await openFromUserMenu(page, "user-menu-account-login");
  const login = page.locator('[data-testid="account-login-page-overlay"]');
  await page.evaluate(() => {
    window.__accountLoginExitAnimation = undefined;
    document.addEventListener("animationend", (event) => {
      if (
        event.target instanceof HTMLElement &&
        event.target.classList.contains("webui-account-login-page-overlay")
      ) {
        window.__accountLoginExitAnimation = event.animationName;
      }
    }, { capture: true });
  });

  await page.keyboard.press("Escape");
  await expect.poll(() => page.evaluate(() => window.__accountLoginExitAnimation))
    .toBe("webui-motion-surface-exit");
  await expect(login).toHaveCount(0);
});

test("切换账号 on the signed-in page signs the current account out before the new sign-in", async ({ page }) => {
  await openApp(page, "#session=A");
  await page.evaluate(() =>
    window.__fixture.setAccountLoginState({ state: "authenticated" }),
  );

  const signOutCount = () =>
    page.evaluate(() => window.__fixture.requests.filter((r) => r.operation === "signOut").length);
  const before = await signOutCount();

  await openFromUserMenu(page, "user-menu-account-login");
  await expect(loginPage(page)).toHaveAttribute("data-webui-account-login-phase", "authenticated", { timeout: 6_000 });

  // The switch is a real sign-out — the operation that removes the
  // credential — and it is followed by a fresh device flow, so the page moves
  // on from the account it just left instead of sitting on it.
  await page.locator('[data-testid="account-login-switch"]').click();
  await expect.poll(signOutCount, { timeout: 6_000 }).toBe(before + 1);
  await expect(loginPage(page)).toHaveAttribute("data-webui-account-login-phase", "awaiting", { timeout: 6_000 });
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

test("usage loading applies the shared pulse animation to each skeleton shape", async ({ page }) => {
  await configureFixture(page, () => window.__fixture.delayEvery("getUsageQuota", {}));
  await openApp(page, "#session=A");
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await expect.poll(() =>
    page.evaluate(() => window.__fixture.pending.some((item) => item.operation === "getUsageQuota")),
  ).toBe(true);
  await page.locator('[data-testid="sidebar-user-menu-trigger"]').click();
  await page.locator('[data-testid="user-menu-usage"]').click();

  const popover = page.getByTestId("usage-popover");
  await expect(popover).toHaveAttribute("data-webui-motion", "surface");
  await expect(popover).toHaveAttribute("data-webui-motion-state", "enter");
  const skeletons = page.locator('[data-testid="usage-popover-loading"] .webui-skeleton.webui-motion-loading');
  await expect(skeletons).toHaveCount(4);
  await expect.poll(() => skeletons.first().evaluate((element) => getComputedStyle(element).animationName))
    .toBe("webui-skeleton-pulse");
  const loadingGeometry = await page.locator('[data-testid="usage-popover-loading"] .webui-skeleton-group > .webui-skeleton').evaluateAll((elements) =>
    elements.map((element) => {
      const rect = element.getBoundingClientRect();
      return { width: rect.width, height: rect.height };
    }),
  );
  expect(loadingGeometry).toHaveLength(4);
  expect(loadingGeometry.every((shape) => shape.width >= 72 && shape.height === 28)).toBe(true);
  expect(new Set(loadingGeometry.map((shape) => shape.width)).size).toBeGreaterThan(2);
  expect(loadingGeometry.slice(1).some((shape, index) => shape.width > loadingGeometry[index].width)).toBe(true);

  await page.evaluate(() => window.__fixture.resolveAllPending("getUsageQuota", {}, { signedIn: false }));
  await expect(page.locator('[data-testid="usage-sign-in-button"]')).toBeVisible();
  await popover.evaluate((element) => {
    window.__usageExitAnimation = undefined;
    const observer = new MutationObserver(() => {
      if (element.getAttribute("data-webui-motion-state") !== "exit") return;
      window.__usageExitAnimation = getComputedStyle(element).animationName;
      observer.disconnect();
    });
    observer.observe(element, { attributes: true, attributeFilter: ["data-webui-motion-state"] });
  });
  await page.mouse.move(1, 1);
  await expect.poll(() => page.evaluate(() => window.__usageExitAnimation)).toBe("webui-motion-surface-exit");
  await expect(popover).toHaveCount(0, { timeout: 500 });
});

test("usage loading keeps the quota popover at its resolved size", async ({ page }) => {
  await configureFixture(page, () => window.__fixture.delayEvery("getUsageQuota", {}));
  await openApp(page, "#session=A");
  await page.evaluate(() => window.__fixture.setUsageQuotaResult({
    signedIn: true,
    creditBalance: "4691",
    quota: {
      fiveHour: { usedPercent: 100, totalPercent: 100, unlimited: false },
      weekly: { usedPercent: 54, totalPercent: 100, unlimited: false },
    },
  }));
  await page.locator('[data-testid="sidebar-user-menu-trigger"]').click();
  await page.locator('[data-testid="user-menu-usage"]').click();

  const popover = page.getByTestId("usage-popover");
  await expect(page.getByTestId("usage-popover-loading")).toBeVisible();
  const loadingSize = await popover.evaluate((element) => {
    const { width, height } = element.getBoundingClientRect();
    return { width, height };
  });

  await page.evaluate(() => window.__fixture.resolveAllPending("getUsageQuota", {}, {
    signedIn: true,
    creditBalance: "4691",
    quota: {
      fiveHour: { usedPercent: 100, totalPercent: 100, unlimited: false },
      weekly: { usedPercent: 54, totalPercent: 100, unlimited: false },
    },
  }));
  await expect(page.getByTestId("usage-popover-content")).toBeVisible();
  const readySize = await popover.evaluate((element) => {
    const { width, height } = element.getBoundingClientRect();
    return { width, height };
  });
  expect(Math.abs(loadingSize.width - readySize.width)).toBeLessThanOrEqual(1);
  expect(Math.abs(loadingSize.height - readySize.height)).toBeLessThanOrEqual(1);
});

test("the legal notice names the account's own documents", async ({ page }) => {
  await openApp(page, "#session=A");
  await openFromUserMenu(page, "user-menu-account-login");

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
