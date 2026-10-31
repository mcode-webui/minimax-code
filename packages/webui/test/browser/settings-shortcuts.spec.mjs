// Settings › 快捷键 — the shortcuts page, driven the way a user drives it.
//
// The page's own promise is that a binding it shows is the binding the
// composer obeys, so the tests here follow one binding through the whole
// round trip: capture it on the page, see it survive a close and a reload,
// and then press the key in the composer and watch the message go — or
// watch it stay.
//
// The evidence is the built client and the in-page fixture transport: the
// fixture records what reached the wire, and the transcript is what the user
// sees afterwards.

import { expect } from "@playwright/test";

import { emitStream, openApp, requestCount, test } from "./harness.mjs";

test.beforeEach(async ({ page }) => {
  page.on("pageerror", (error) => console.error("BROWSER_PAGE_ERROR", error.stack ?? error.message));
  page.on("console", (message) => { if (message.type() === "error") console.error("BROWSER_CONSOLE_ERROR", message.text()); });
});

function settingsDialog(page) {
  return page.locator('[role="dialog"][aria-label="设置"]');
}

function settingsNavItem(page, key) {
  return page.locator(`[data-menu-key="${key}"]`);
}

/** Opens settings the way a user does: user menu, then 设置. */
async function openSettings(page) {
  await page.locator('[data-testid="sidebar-user-menu-trigger"]').click();
  await page.locator('[data-testid="user-menu-settings"]').click();
  await expect(settingsDialog(page)).toBeVisible();
}

/** Leaves the settings the way a user does: the 返回应用 button. */
async function closeSettings(page) {
  await page.locator('[aria-label="返回"]').click();
  await expect(settingsDialog(page)).toHaveCount(0);
}

function composer(page) {
  return page.getByPlaceholder("输入消息…（输入 / 唤起命令）");
}

/** The chip that shows an action's current binding, and captures a new one. */
function shortcutKey(page, action) {
  return page.locator(`[data-testid="mavis-settings-shortcut-${action}"]`);
}

/** The stored bindings, as the browser holds them. */
function storedShortcuts(page) {
  return page.evaluate(() => localStorage.getItem("webui-shortcuts.v1"));
}

/** Opens the shortcuts page. */
async function openShortcuts(page) {
  await settingsNavItem(page, "shortcuts").click();
  await expect(page.locator('[data-testid="settings-shortcuts-page"]')).toBeVisible();
}

/** Rebinds an action to a combination, the way the page captures one. */
async function rebind(page, action, combination) {
  await shortcutKey(page, action).click();
  await expect(shortcutKey(page, action)).toHaveText("按下组合键…");
  await page.keyboard.press(combination);
}

/** The texts the client sent, as the fixture recorded them. */
function sentContent(page) {
  return page.evaluate(() =>
    window.__fixture.requests
      .filter((request) => request.operation === "sendMessage")
      .map((request) => request.body.content),
  );
}

/**
 * The server's echo of a submitted message.
 *
 * The client sends a message and the turn comes back on the stream; the
 * transcript shows what the server echoed. Echoing it here is what puts the
 * submitted text in the transcript the user reads.
 */
async function echoTurn(page, sessionId, text) {
  await emitStream(page, sessionId, {
    dataJson: JSON.stringify({ type: "agent_message", agent_message: { msg_id: `msg-user-${text}`, msg_content: text, role: "user" } }),
  });
}

/** Ends the live turn, so the composer can take the next submission. */
async function endTurn(page, sessionId) {
  await emitStream(page, sessionId, { dataJson: "[DONE]" });
}

test("the shortcuts tab opens and lists the actions with their current bindings", async ({ page }) => {
  await openApp(page, "#session=A");
  await openSettings(page);
  await openShortcuts(page);

  // The tab is a real page now, not a label that leads nowhere.
  await expect(page.locator('[data-testid="shortcuts-section"]')).toBeVisible();
  // And it is the only thing on the panel: the empty-page fallback that
  // covers the tabs with no content behind them must not appear beside it.
  await expect(page.locator('[aria-label="空设置面板"]')).toHaveCount(0);
  await expect(shortcutKey(page, "submit")).toHaveText("Enter");
  await expect(shortcutKey(page, "newline")).toHaveText("Shift + Enter");
  // Stopping a generation is a button and nothing else, and the row says so
  // rather than offering a binding that would fight the Escape the menus own.
  await expect(shortcutKey(page, "stop")).toHaveText("仅按钮，无快捷键");
});

test("a captured combination becomes the binding the page shows", async ({ page }) => {
  await openApp(page, "#session=A");
  await openSettings(page);
  await openShortcuts(page);

  await rebind(page, "submit", "Control+Enter");
  await expect(shortcutKey(page, "submit")).toHaveText("Ctrl + Enter");

  // A combination that is already taken is refused, and the row that holds it
  // is named. The capture stays open so the user can press another one;
  // Escape leaves it, and the binding is the one it was.
  await rebind(page, "newline", "Control+Enter");
  await expect(page.locator('[data-testid="mavis-settings-shortcut-error"]')).toContainText("发送消息");
  await page.keyboard.press("Escape");
  await expect(shortcutKey(page, "newline")).toHaveText("Shift + Enter");
  await expect(page.locator('[data-testid="mavis-settings-shortcut-error"]')).toHaveCount(0);
});

test("the binding survives closing the settings and coming back", async ({ page }) => {
  await openApp(page, "#session=A");
  await openSettings(page);
  await openShortcuts(page);
  await rebind(page, "submit", "Control+Enter");
  await expect(shortcutKey(page, "submit")).toHaveText("Ctrl + Enter");

  await closeSettings(page);
  await openSettings(page);
  await openShortcuts(page);

  await expect(shortcutKey(page, "submit")).toHaveText("Ctrl + Enter");
  // The page's own state would survive a close, so the stored value is what
  // makes this a persistence claim rather than a rendering one.
  expect(await storedShortcuts(page)).toContain("Control+Enter");
});

test("the binding survives a reload", async ({ page }) => {
  await openApp(page, "#session=A");
  await openSettings(page);
  await openShortcuts(page);
  await rebind(page, "submit", "Control+Enter");
  await expect(shortcutKey(page, "submit")).toHaveText("Ctrl + Enter");

  await page.reload();
  await expect(page.locator("#webui-root")).toBeVisible();
  await openSettings(page);
  await openShortcuts(page);

  await expect(shortcutKey(page, "submit")).toHaveText("Ctrl + Enter");
  expect(await storedShortcuts(page)).toContain("Control+Enter");
});

test("the composer sends on the new binding and no longer on the old one", async ({ page }) => {
  await openApp(page, "#session=A");
  const input = composer(page);

  // The control leg: under the built-in binding, Enter sends. Without it, the
  // assertions below would pass against a composer that never sends at all.
  await input.click();
  await input.pressSequentially("默认回车发送");
  await input.press("Enter");
  await expect.poll(() => sentContent(page)).toContain("默认回车发送");
  await echoTurn(page, "A", "默认回车发送");
  await expect(page.locator('[data-webui-transcript="A"]')).toContainText("默认回车发送");
  await endTurn(page, "A");

  await openSettings(page);
  await openShortcuts(page);
  await rebind(page, "submit", "Control+Enter");
  await expect(shortcutKey(page, "submit")).toHaveText("Ctrl + Enter");
  await closeSettings(page);

  // The new binding sends: the text the user typed is what reached the wire,
  // and the transcript shows the turn that carried it.
  await input.click();
  await input.pressSequentially("新键发送");
  await input.press("Control+Enter");
  await expect.poll(() => sentContent(page)).toContain("新键发送");
  await expect(input).toHaveValue("");
  await echoTurn(page, "A", "新键发送");
  await expect(page.locator('[data-webui-transcript="A"]')).toContainText("新键发送");
  await endTurn(page, "A");

  // The old one does not: the draft is still there, with the line break the
  // browser breaks it with, and nothing was sent for it.
  await input.click();
  await input.pressSequentially("旧键不发");
  await input.press("Enter");
  await expect(input).toHaveValue("旧键不发\n");
  expect(await sentContent(page)).not.toContain("旧键不发");
  await expect(page.locator('[data-webui-transcript="A"]')).not.toContainText("旧键不发");
});

test("恢复默认 puts the built-in binding back and the composer follows it", async ({ page }) => {
  await openApp(page, "#session=A");
  await openSettings(page);
  await openShortcuts(page);
  await rebind(page, "submit", "Control+Enter");
  await expect(shortcutKey(page, "submit")).toHaveText("Ctrl + Enter");

  await page.locator('[data-testid="mavis-settings-shortcuts-reset"]').click();
  await expect(shortcutKey(page, "submit")).toHaveText("Enter");
  await closeSettings(page);

  // The behaviour followed the binding back: Enter sends again.
  const input = composer(page);
  await input.click();
  await input.pressSequentially("回退后发送");
  await input.press("Enter");
  await expect.poll(() => sentContent(page)).toContain("回退后发送");
  await echoTurn(page, "A", "回退后发送");
  await expect(page.locator('[data-webui-transcript="A"]')).toContainText("回退后发送");
});

test("a newline bound to a key the browser does not break the line on breaks it anyway", async ({ page }) => {
  await openApp(page, "#session=A");
  await openSettings(page);
  await openShortcuts(page);
  await rebind(page, "newline", "Control+J");
  await expect(shortcutKey(page, "newline")).toHaveText("Ctrl + J");
  await closeSettings(page);

  const input = composer(page);
  await input.click();
  await input.pressSequentially("换行键");
  await input.press("Control+J");
  await expect(input).toHaveValue("换行键\n");
  await expect.poll(() => requestCount(page, "sendMessage")).toBe(0);
});
