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
//    `key`-ed branch, and the account page it renders is the ported one: the
//    profile block, the three headline numbers, the usage calendar and the
//    "分享" action. The 分享 preview is what the unit suite cannot reach —
//    it is a portal over the whole screen, and "the button opens a preview"
//    is only observable here.
//
// 2. The boundary. `main.tsx` now wraps the app in `WebuiErrorBoundary`, and
//    `webui-error-boundary.test.tsx` drives the component directly with a child
//    that throws. That proves the class does what a class does. It says nothing
//    about the two things that are only true of *this* app in *this* bundle:
//    that the boundary is really mounted around the real tree, and that a throw
//    raised by real projection code reaches it. So the crash here is provoked
//    the way it happens in the field — a `getSessionTree` answer that omits a
//    field the rail is typed as always present — and the assertion is that the
//    failure becomes a retryable surface and that retry really restores the app.
//
// The healthy half matters as much as the crash half. A boundary that
// swallows good renders, or that wraps so much that the app stops responding,
// would pass a crash-only test while being worse than no boundary at all. So
// the rail, the composer and the settings modal are each driven for real.

import { expect } from "@playwright/test";

import { configureFixture, openApp, switchSession, test } from "./harness.mjs";

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
 * the project rail uses for its context actions.
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
 * The account page the ported branch renders.
 *
 * The account tab no longer carries a settings section of its own — the
 * "账户信息 / 退出登录" row was removed — so the page is located by the
 * element it actually is: the ported account page.
 */
function accountPanel(page) {
  return page.locator('[data-testid="account-usage-settings"]');
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

test("the account tab is enabled where the unfinished tabs are still disabled", async ({ page }) => {
  await openApp(page, "#session=A");
  await openSettings(page);

  await expect(accountTab(page)).toBeVisible();
  await expect(accountTab(page)).toBeEnabled();
  expect(await accountTab(page).textContent()).toBe("账户");

  // The other half, and the reason the assertion above is not vacuous: the nav
  // really does still ship disabled items, so "enabled" is a fact about this
  // tab rather than a property of every button in the sidebar. A nav that
  // silently enabled 语音/连接 would pass the first two lines.
  //
  // 代码审查, 工作树 and 快捷键 left this list when their pages were built —
  // they are real panels now, not empty panes behind a clickable label. The two
  // that remain have no content behind them, which is what the `disabled` gate
  // is still for.
  for (const key of ["voice", "connection"]) {
    await expect(settingsNavItem(page, key)).toBeDisabled();
  }
  // The app behind the modal is still mounted: the modal is a `document.body`
  // portal, so it renders over a live app rather than replacing it. A fallback
  // here would mean the crash surface is showing while settings are open.
  await expect(page.locator('[data-testid="webui-error-boundary"]')).toHaveCount(0);
});

test("the code-review and worktree tabs open their own panels instead of an empty pane", async ({ page }) => {
  await openApp(page, "#session=A");
  await openSettings(page);

  // Same argument as the account tab above, and the reason the unit suite
  // cannot stand in: `disabled: false` is a flag on the definition, while
  // "clicking it lands on the page" is the feature. The empty-pane
  // placeholder is the failure this has to rule out — a clickable label with
  // nothing behind it is exactly the state these two tabs were in.
  await expect(settingsNavItem(page, "coding")).toBeEnabled();
  await settingsNavItem(page, "coding").click();
  await expect(page.locator('[data-testid="settings-review-page"]')).toBeVisible();
  // One status marker, and it is the review page's own: with no workspace
  // selected the page says so instead of rendering a bare heading.
  await expect(page.locator("[data-webui-review-state]")).toHaveCount(1);
  await expect(page.locator(".webui-settings-empty-panel")).toHaveCount(0);

  await expect(settingsNavItem(page, "worktree")).toBeEnabled();
  await settingsNavItem(page, "worktree").click();
  await expect(page.locator('[data-testid="settings-worktree-page"]')).toBeVisible();
  await expect(page.locator(".webui-settings-empty-panel")).toHaveCount(0);
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

  // The ported account page: the profile block, the three headline numbers and
  // the usage calendar. The fixture transport reports no usage, so the numbers
  // read as the Desktop's own empty reading ("--") rather than as a failure --
  // a missing answer is a runtime fact, not a rendering defect.
  await expect(accountPanel(page)).toBeVisible();
  await expect(page.locator('[data-testid="account-usage-profile"]')).toBeVisible();
  await expect(page.locator('[data-testid="account-usage-metrics"]')).toBeVisible();
  await expect(page.locator('[data-testid="account-usage-metric"]')).toHaveCount(3);
  await expect(page.locator('[data-testid="account-usage-activity"]')).toBeVisible();
  await expect(accountPanel(page).getByText("Token 用量")).toBeVisible();

  // The "账户信息 / 退出登录" row is gone: the account tab is the ported page
  // and nothing else. Asserted rather than assumed, because a leftover row
  // would be the one thing in this tab that no longer has a Desktop
  // counterpart.
  await expect(signOutButton(page)).toHaveCount(0);
  await expect(accountPanel(page).getByText("账户信息")).toHaveCount(0);
  await expect(page.locator('[data-testid="webui-error-boundary"]')).toHaveCount(0);
});

test("the account panel's 分享 action opens the share preview", async ({ page }) => {
  await openApp(page, "#session=A");
  await openSettings(page);
  await accountTab(page).click();

  // The action lives in the settings header, next to the tab title, the way
  // the Desktop puts it in the account page's own top-right corner.
  const share = page.locator('[data-testid="account-usage-share-button"]');
  await expect(share).toBeVisible();
  await expect(share).toBeEnabled();

  // ...and it is wired, not merely enabled: the click has to open the
  // preview, which is a portal over the whole screen.
  await share.click();
  await expect(page.locator('[data-testid="account-usage-share-preview"]')).toBeVisible();
  await expect(page.locator('[data-testid="account-usage-share-card"]')).toBeVisible();

  // The preview carries no close button of its own, so the scrim is the way
  // out: a click outside the card dismisses it. The click has to land on the
  // scrim itself, which is why the position is the corner rather than the
  // centre — the centre of the scrim is the card.
  await page.locator(".webui-settings-dialog-mask").click({ position: { x: 8, y: 8 } });
  await expect(page.locator('[data-testid="account-usage-share-preview"]')).toHaveCount(0);
});

test("the boundary did not break the healthy app around it", async ({ page }) => {
  await openApp(page, "#session=A");

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
 * Hold the boot `getSessionTree` request so the crash can be provoked later.
 *
 * Must run BEFORE `openApp`: the app fetches the tree exactly once, on mount,
 * so a hold installed afterwards would never catch anything. The app boots
 * normally with the request outstanding (the rail falls back to the flat list),
 * which is what lets the test assert the app was healthy before it broke.
 */
function holdSessionTree(page) {
  return configureFixture(page, () => window.__fixture.delayEvery("getSessionTree", { name: "main" }));
}

/**
 * Answers the held tree request with a node whose `title` is not a string.
 *
 * This exercises the error boundary, and it is deliberately independent of the
 * tree field the client now reads defensively: a missing `childSessions` used
 * to be the crash, but the ingest reducer guards it now (see the
 * "a tree node without childSessions degrades instead of crashing" test below),
 * so it can no longer provoke a render throw. What is still unguarded is the
 * session's own title: the rail derives the row label with
 * `session.title?.trim()`, and optional chaining does not save an object from
 * `.trim()` — the throw is a plain `TypeError` from a render path, which is
 * exactly what the boundary exists to catch.
 *
 * The wire type says `title` is a string; serving an object is malformed input
 * of the same class the tree test used, and no component is stubbed.
 */
async function crashAppIntoBoundary(page) {
  await expect.poll(() => page.evaluate(() => window.__fixture.requests.filter((request) => request.operation === "getSessionTree").length)).toBeGreaterThan(0);
  await page.evaluate(() =>
    window.__fixture.resolve("getSessionTree", { name: "main" }, {
      // `title` is an object, not a string -- see the note above.
      sessions: [{ session: { sessionId: "A", agentName: "synthetic-A", title: { not: "a string" }, createdAt: 1_700_000_000_000, updatedAt: 1_700_000_000_000, workspaceDir: "/synthetic/workspace" }, childSessions: [] }],
      hasMore: false,
    }),
  );
  await expect(page.locator('[data-testid="webui-error-boundary"]')).toBeVisible();
}

/** The tree page the server answers with once the bad one is repaired. */
function repairedTree() {
  return {
    sessions: [{ session: { sessionId: "A", agentName: "synthetic-A", title: "绿川椒 Demo 订货小程序", createdAt: 1_700_000_000_000, updatedAt: 1_700_000_000_000, workspaceDir: "/synthetic/workspace" }, childSessions: [] }],
    hasMore: false,
  };
}

test("a render throw in the app becomes a retryable surface", async ({ page }) => {
  await holdSessionTree(page);
  await openApp(page, "#session=A");
  await expect(page.locator('[data-testid="webui-error-boundary"]')).toHaveCount(0);

  await crashAppIntoBoundary(page);

  // The cause is shown, not only logged. A user who cannot describe the failure
  // has nothing to report, and this is the only place the message survives the
  // unmount of the tree that threw. The text is the V8 message for the
  // unguarded `for...of` over the missing field, asserted verbatim: a fuzzy
  // match would also pass if the app failed somewhere else entirely, which is
  // the one thing this test exists to rule out.
  await expect(page.locator('[data-testid="webui-error-boundary-title"]')).toHaveText("界面出现错误");
  // React's own validation error is the one that reaches the boundary here: the
  // rail renders the malformed title as a child, so the object-as-child check
  // fires first. Pinned verbatim, because a fuzzy match would also pass if the
  // app failed somewhere else entirely -- the one thing this test rules out.
  await expect(page.locator('[data-testid="webui-error-boundary-message"]'))
    .toHaveText("Objects are not valid as a React child (found: object with keys {not}). If you meant to render a collection of children, use an array instead.");
  await expect(page.locator('[data-testid="webui-error-boundary-retry"]')).toBeEnabled();

  // The app is genuinely unmounted, not merely covered. Counting rows is the
  // honest check: a fallback layered on top of a still-live rail would leave
  // both in the DOM and pass a `toBeVisible()` on the alert alone.
  await expect(page.locator("[data-webui-session-link]")).toHaveCount(0);
  await expect(page.getByPlaceholder("输入消息…（输入 / 唤起命令）")).toHaveCount(0);
});

test("retry after a render error brings the app back", async ({ page }) => {
  await holdSessionTree(page);
  await openApp(page, "#session=A");
  await crashAppIntoBoundary(page);

  // Fix the server's answer before retrying, so "retry recovers" is a claim
  // about the recovery path and not about the data having self-healed. Retrying
  // remounts the app, which re-reads the tree from scratch, so the repair has
  // to be in the fixture rather than in the crashed tree.
  await page.evaluate((tree) => window.__fixture.setTree(tree), repairedTree());
  await page.locator('[data-testid="webui-error-boundary-retry"]').click();

  // Recovered means the app is usable again, not that the alert went away: the
  // rail, the composer and the transcript all have to be back.
  await expect(page.locator('[data-testid="webui-error-boundary"]')).toHaveCount(0);
  await expect(page.locator('[data-webui-session-link="A"]')).toBeVisible();
  await expect(page.locator('[data-webui-session-link="B"]')).toBeVisible();
  // The composer is back and usable. Its input MODE is not asserted here: the
  // recovered app reconciles the session's goal on the accepted channel (plan
  // §4.3), so a session with an active goal legitimately opens in goal mode —
  // which is what this spec's fixture holds. What this case is about is that the
  // composer exists again at all.
  await expect(page.locator("textarea").first()).toBeVisible();
  await expect(page.getByText("History A synthetic")).toBeVisible();

  // And the recovered app is not a frozen snapshot of the failed render: the
  // rail takes input again.
  await clickSessionRow(page, "B");
  await expect(page.getByText("History B synthetic")).toBeVisible();
});

test("a tree node without childSessions degrades instead of crashing", async ({ page }) => {
  await holdSessionTree(page);
  await openApp(page, "#session=A");
  await expect(page.locator('[data-testid="webui-error-boundary"]')).toHaveCount(0);

  // The node has no `childSessions` key at all. The ingest reducer reads it
  // defensively, so the node survives as a session with no children and the
  // rest of the page still loads -- the failure this used to be was silent and
  // total: the throw was swallowed by `loadTree`'s catch, so one such node
  // emptied the whole tree view with no error anywhere.
  await page.evaluate(() =>
    window.__fixture.resolve("getSessionTree", { name: "main" }, {
      sessions: [{ session: { sessionId: "A", agentName: "synthetic-A", title: "绿川椒 Demo 订货小程序", createdAt: 1_700_000_000_000, updatedAt: 1_700_000_000_000, workspaceDir: "/synthetic/workspace" } }],
      hasMore: false,
    }),
  );

  await expect(page.locator('[data-testid="webui-error-boundary"]')).toHaveCount(0);
  await expect(page.locator('[data-webui-session-link="A"]')).toBeVisible();
  await expect(page.getByPlaceholder("输入消息…（输入 / 唤起命令）")).toBeVisible();
});

test("a malformed msgContent is handled, not crashed on", async ({ page }) => {
  await openApp(page, "#session=A");

  // The same payload the crash test used to rely on, now asserted as what it
  // became: a message the projection is entitled to drop. Without this, the
  // crash test's replacement would look like the guard simply removed coverage
  // of a shape the wire can carry -- here it is still carried, the transcript
  // still renders its neighbours, and nothing reaches the boundary.
  await page.evaluate(() =>
    window.__fixture.setPage("A", {
      messages: [
        { msgId: "history-A", role: "user", msgContent: "History A synthetic", timestamp: 1_700_000_000_001 },
        { msgId: "hostile-1", role: "assistant", msgContent: 42, timestamp: 1_700_000_000_002 },
      ],
      hasMore: false,
    }),
  );
  // A's page was already fetched at boot, so the new one is only read on the
  // next request for it; going via B guarantees that request happens.
  await switchSession(page, "B");
  await expect(activeSessionRow(page, "B")).toBeVisible();
  await switchSession(page, "A");

  // The good neighbour still renders, so the page is not simply blank.
  await expect(page.getByText("History A synthetic")).toBeVisible();
  // ...and the app is still the app: rail, composer, no crash surface.
  await expect(page.locator('[data-webui-session-link="A"]')).toBeVisible();
  await expect(page.getByPlaceholder("输入消息…（输入 / 唤起命令）")).toBeVisible();
  await expect(page.locator('[data-testid="webui-error-boundary"]')).toHaveCount(0);
});
