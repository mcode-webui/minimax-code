// Settings › account tab, and the app-wide error boundary, end to end against
// the built client.
//
// Two claims in this branch exist only in a browser, and neither is a formality.
//
// 1. The account tab. Removing `disabled: true` from the tab definition is a
//    one-token change, and the unit suite can only see the array it edits. What
//    it cannot see is the whole point: whether a *user* can reach the panel.
//    `disabled` on a `<button>` is not a style, it is the browser refusing the
//    click, so "the flag is gone" and "the panel opens" are different facts and
//    only the second one is the feature. The panel also renders through a
//    `key`-ed branch, and the one action it offers is gated on a capability
//    that comes off the real transport rather than off the fixture — which is
//    what makes "the button is operable" worth asserting instead of merely
//    "the button exists".
//
// 2. The boundary. `main.tsx` now wraps the app in `WebuiErrorBoundary`, and
//    `webui-error-boundary.test.tsx` drives the component directly with a child
//    that throws. That proves the class does what a class does. It says nothing
//    about the two things that are only true of *this* app in *this* bundle:
//    that the boundary is really mounted around the real tree, and that a throw
//    raised by real projection code reaches it. So the crash here is provoked
//    the way it happens in the field — a `getMessages` response whose
//    `msgContent` is a number — and the assertion is that the failure becomes a
//    retryable surface and that retry really restores the app.
//
// The healthy half matters as much as the crash half. A boundary that
// swallows good renders, or that wraps so much that the app stops responding,
// would pass a crash-only test while being worse than no boundary at all. So
// the rail, the composer and the settings modal are each driven for real.

import { expect, test } from "@playwright/test";

import { assertHarnessServer, openApp, switchSession } from "./harness.mjs";

test.beforeEach(async ({ page }) => {
  page.on("pageerror", (error) => console.error("BROWSER_PAGE_ERROR", error.stack ?? error.message));
  page.on("console", (message) => { if (message.type() === "error") console.error("BROWSER_CONSOLE_ERROR", message.text()); });
});

function settingsDialog(page) {
  return page.locator('[role="dialog"][aria-label="设置"]');
}

function settingsNavItem(page, key) {
  return page.locator(`.webui-settings-nav [data-menu-key="${key}"]`);
}

/** The tab that opens whatever panel the account branch renders. */
function accountTab(page) {
  return settingsNavItem(page, "account");
}

/**
 * Clicks a rail row at its label rather than at its centre.
 *
 * The row's hover action strip is absolutely positioned over the right-hand end
 * of the row and, at `opacity: 0`, still takes the hit -- so a centre click
 * lands on the star button and Playwright refuses it as intercepted. Same trap
 * `rail-star.spec.mjs` documents for right-clicks.
 */
function clickSessionRow(page, sessionId) {
  return page.locator(`[data-webui-session-link="${sessionId}"]`).click({ position: { x: 40, y: 16 } });
}

/**
 * The rail's own "this row is the open session" marker.
 *
 * `data-webui-session-active`, not `aria-current`: the row is a link to
 * `#session=<id>`, and navigation state there is `data-webui-session-active`.
 * An `aria-current` locator would silently match nothing and, since the row is
 * always rendered, still read as a healthy rail.
 */
function activeSessionRow(page, sessionId) {
  return page.locator(`[data-webui-session-link="${sessionId}"][data-webui-session-active="true"]`);
}

function signOutButton(page) {
  return page.getByRole("button", { name: "退出登录" });
}

/**
 * Opens settings the way a user does: user menu, then 设置.
 *
 * The menu item rather than a prop or a hash, because the route to the modal is
 * part of what is being tested. `<SettingsModal>` is portalled to `document.body`
 * by `UserMenu`, so every locator below stays in `page`, never in `#webui-root`.
 */
async function openSettings(page) {
  await page.locator('[data-testid="sidebar-user-menu-trigger"]').click();
  await page.locator('[data-testid="user-menu-settings"]').click();
  await expect(settingsDialog(page)).toBeVisible();
}

function accountPanel(page) {
  return page.locator(".webui-settings-panels .webui-settings-panel");
}

test("the account tab is enabled where the unfinished tabs are still disabled", async ({ page }) => {
  await openApp(page, "#session=A");
  await openSettings(page);

  await expect(accountTab(page)).toBeVisible();
  await expect(accountTab(page)).toBeEnabled();
  expect(await accountTab(page).textContent()).toBe("账户");

  // The other half, and the reason the assertion above is not vacuous: the nav
  // really does still ship disabled items, so "enabled" is a fact about this
  // tab rather than a property of every button in the sidebar. A nav that
  // silently enabled 语音/快捷键/连接/代码审查 would pass the first two lines.
  for (const key of ["voice", "shortcuts", "connection", "coding"]) {
    await expect(settingsNavItem(page, key)).toBeDisabled();
  }
  // The app behind the modal is still mounted: the modal is a `document.body`
  // portal, so it renders over a live app rather than replacing it. A fallback
  // here would mean the crash surface is showing while settings are open.
  await expect(page.locator('[data-testid="webui-error-boundary"]')).toHaveCount(0);
});

test("clicking the account tab shows the account panel", async ({ page }) => {
  await openApp(page, "#session=A");
  await openSettings(page);

  // The nav item is clickable, and the click is not swallowed by an overlay
  // covering the sidebar.
  await accountTab(page).click();

  // The content header follows the active tab, so it is what proves the click
  // reached the component state rather than only the button's own class list.
  await expect(page.locator(".webui-settings-content-header h2")).toHaveText("账户");
  await expect(accountPanel(page)).toBeVisible();
  await expect(accountPanel(page).locator("h3")).toHaveText("账户");
  // The one row the panel has. Its description is the account email, which the
  // fixture transport does not report, so only the row's own presence is
  // asserted -- an empty email is a runtime fact, not a failure.
  await expect(accountPanel(page).getByText("账户信息")).toBeVisible();
  await expect(signOutButton(page)).toBeVisible();
  await expect(page.locator('[data-testid="webui-error-boundary"]')).toHaveCount(0);
});

test("the account panel's sign-out button is operable, not a dead end", async ({ page }) => {
  await openApp(page, "#session=A");
  await openSettings(page);
  await accountTab(page).click();

  // `disabled={!signOut}`, and `signOut` is bound off the transport that
  // `main.tsx` builds from the runtime config -- NOT off the in-page fixture,
  // which only replaces `WebSocket`. So an enabled button here is a real
  // capability reaching the panel. If it ever renders disabled, this PR ships
  // an account tab whose only action can never fire, and that is worth a loud
  // failure rather than a silent one.
  await expect(signOutButton(page)).toBeEnabled();

  // ...and it is wired, not merely enabled. A click has to reach the transport.
  await signOutButton(page).click();
  await expect.poll(() => page.evaluate(() => window.__fixture.requests.some((request) => request.operation === "signOut"))).toBe(true);
  // `handleSignOut` closes the modal on success, so the modal leaving is the
  // observable half of a completed sign-out.
  await expect(settingsDialog(page)).toHaveCount(0);
});

test("the boundary did not break the healthy app around it", async ({ page }) => {
  await openApp(page, "#session=A");
  await assertHarnessServer(page);

  // A boundary that rendered on every pass would be worse than no boundary:
  // it would blank a working app. The fallback must be absent, not merely
  // unstyled.
  await expect(page.locator('[data-testid="webui-error-boundary"]')).toHaveCount(0);

  // The rail: rows, and a click that actually changes the session.
  await expect(page.locator('[data-webui-session-link="A"]')).toBeVisible();
  await expect(page.locator('[data-webui-session-link="B"]')).toBeVisible();
  await clickSessionRow(page, "B");
  await expect(activeSessionRow(page, "B")).toBeVisible();
  await expect(page.getByText("History B synthetic")).toBeVisible();

  // The composer: present, enabled, and accepting a keystroke. An app that
  // renders but ignores input still looks healthy in a screenshot.
  const composer = page.getByPlaceholder("输入消息…（输入 / 唤起命令）");
  await expect(composer).toBeVisible();
  await expect(composer).toBeEnabled();
  await composer.fill("边界在两侧都要是好的");
  await expect(composer).toHaveValue("边界在两侧都要是好的");

  // The settings modal: opens, switches panel, and closes again. The last step
  // matters most -- the modal is a `document.body` portal, so a boundary around
  // the app tree cannot see it, and a modal that would not close would be the
  // kind of breakage only a click reveals.
  await openSettings(page);
  await settingsNavItem(page, "usage").click();
  await expect(page.locator(".webui-settings-content-header h2")).toHaveText("用量与模型");
  await page.locator('.webui-settings-back[aria-label="返回"]').click();
  await expect(settingsDialog(page)).toHaveCount(0);
  await expect(composer).toBeVisible();
  await expect(page.locator('[data-testid="webui-error-boundary"]')).toHaveCount(0);
});

/**
 * Drives the app into a real render throw and leaves it there.
 *
 * The payload is the field type the wire contract promises to be a string. A
 * runtime that emits a number for it is an ordinary server-side bug, and it is
 * the shape that makes `message.msgContent?.trimStart` throw during the
 * transcript's render -- no production hook, no test-only flag, no stubbing of
 * the component under test.
 *
 * The switch away and back matters: at boot A's first page is already fetched,
 * so the poisoned page is only read on the next request for it. Going via B
 * guarantees that request happens. B is left untouched on the way through, so
 * this is a single crash, not two.
 */
async function crashAppIntoBoundary(page) {
  await page.evaluate(() =>
    window.__fixture.setPage("A", {
      messages: [{ msgId: "hostile-1", role: "assistant", msgContent: 42, timestamp: 1_700_000_000_001 }],
      hasMore: false,
    }),
  );
  await switchSession(page, "B");
  await expect(activeSessionRow(page, "B")).toBeVisible();
  await switchSession(page, "A");
  await expect(page.locator('[data-testid="webui-error-boundary"]')).toBeVisible();
}

test("a render throw in the app becomes a retryable surface", async ({ page }) => {
  await openApp(page, "#session=A");
  await expect(page.locator('[data-testid="webui-error-boundary"]')).toHaveCount(0);

  await crashAppIntoBoundary(page);

  // The cause is shown, not only logged. A user who cannot describe the failure
  // has nothing to report, and this is the only place the message survives the
  // unmount of the tree that threw.
  await expect(page.locator('[data-testid="webui-error-boundary-title"]')).toHaveText("界面出现错误");
  await expect(page.locator('[data-testid="webui-error-boundary-message"]'))
    .toHaveText("message.msgContent?.trimStart is not a function");
  await expect(page.locator('[data-testid="webui-error-boundary-retry"]')).toBeEnabled();

  // The app is genuinely unmounted, not merely covered. Counting rows is the
  // honest check: a fallback layered on top of a still-live rail would leave
  // both in the DOM and pass a `toBeVisible()` on the alert alone.
  await expect(page.locator("[data-webui-session-link]")).toHaveCount(0);
  await expect(page.getByPlaceholder("输入消息…（输入 / 唤起命令）")).toHaveCount(0);
});

test("retry after a render error brings the app back", async ({ page }) => {
  await openApp(page, "#session=A");
  await crashAppIntoBoundary(page);

  // Fix the server's answer before retrying, so "retry recovers" is a claim
  // about the recovery path and not about the data having self-healed.
  await page.evaluate(() =>
    window.__fixture.setPage("A", {
      messages: [{ msgId: "history-A", role: "user", msgContent: "History A synthetic", timestamp: 1_700_000_000_001 }],
      hasMore: false,
    }),
  );
  await page.locator('[data-testid="webui-error-boundary-retry"]').click();

  // Recovered means the app is usable again, not that the alert went away: the
  // rail, the composer and the transcript all have to be back.
  await expect(page.locator('[data-testid="webui-error-boundary"]')).toHaveCount(0);
  await expect(page.locator('[data-webui-session-link="A"]')).toBeVisible();
  await expect(page.locator('[data-webui-session-link="B"]')).toBeVisible();
  await expect(page.getByPlaceholder("输入消息…（输入 / 唤起命令）")).toBeVisible();
  await expect(page.getByText("History A synthetic")).toBeVisible();

  // And the recovered app is not a frozen snapshot of the failed render: the
  // rail takes input again.
  await clickSessionRow(page, "B");
  await expect(page.getByText("History B synthetic")).toBeVisible();
});
