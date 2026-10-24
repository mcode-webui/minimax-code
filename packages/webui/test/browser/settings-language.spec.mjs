// Settings › 通用 › Language — the language row (语言 / Language), driven the
// way a user drives it, against the built client.
//
// The unit suite proves the pack, the lookup and the search. It cannot prove
// the three things that make this a feature rather than a data structure: that
// the page's words actually change when the row is used, that the document
// says which language it is in, and that the choice is still there after the
// dialog is closed and opened again. Those are all round trips through pieces
// the unit suite cannot mount — the `<select>`, the `localStorage` write, the
// effect that re-renders the page and the effect that writes the document's
// `lang` attribute.
//
// The locale is read from `mavis-locale`, the key the page already used, so
// the assertions read that key and not some new one.

import { expect } from "@playwright/test";

import { openApp, test } from "./harness.mjs";

test.beforeEach(async ({ page }) => {
  page.on("pageerror", (error) => console.error("BROWSER_PAGE_ERROR", error.stack ?? error.message));
  page.on("console", (message) => { if (message.type() === "error") console.error("BROWSER_CONSOLE_ERROR", message.text()); });
});

/** The settings dialog, found by its own surface rather than by its name.
 *
 * The dialog carries an `aria-label` that is part of the copy under test, so
 * a locator built from it would only work in one of the two languages. */
function settingsDialog(page) {
  return page.locator(".webui-settings-modal");
}

/** Opens settings the way a user does: user menu, then 设置. */
async function openSettings(page) {
  await page.locator('[data-testid="sidebar-user-menu-trigger"]').click();
  await page.locator('[data-testid="user-menu-settings"]').click();
  await expect(settingsDialog(page)).toBeVisible();
}

/** The back button closes the dialog. Its label is copy too, so it is found by
 * its own class. */
function closeSettings(page) {
  return page.locator(".webui-settings-back").click();
}

function languageRow(page) {
  return page.locator('[data-testid="mavis-settings-language-row"]');
}

function languageSelect(page) {
  return page.locator('[data-testid="mavis-settings-language-select"] select');
}

function settingsSearch(page) {
  return page.locator(".webui-settings-search input");
}

/** A sidebar tab, found by the text on it. */
function navTab(page, label) {
  return page.locator(".webui-settings-nav .menu-label", { hasText: label });
}

/** A sidebar group heading — the 偏好 / 管理 / 编码 / 归档 headings above the
 * tabs, not the tabs themselves. */
function navGroup(page, label) {
  return page.locator(".webui-settings-nav .webui-settings-group h3", { hasText: label });
}

/** The language the page stored, and the language the document declares. */
function storedLocale(page) {
  return page.evaluate(() => localStorage.getItem("mavis-locale"));
}

function documentLang(page) {
  return page.evaluate(() => document.documentElement.lang);
}

test("the language row switches the page and the document's language", async ({ page }) => {
  await openApp(page, "#session=A");
  await openSettings(page);

  // The row is there to be used, and a fresh install reads Chinese — the
  // language the settings page was written in. The document says so too, which
  // is the half of the contract a reader with a screen reader depends on.
  await expect(languageRow(page)).toBeVisible();
  await expect(navTab(page, "通用")).toBeVisible();
  await expect(navGroup(page, "偏好")).toBeVisible();
  await expect.poll(() => documentLang(page)).toBe("zh-CN");

  await languageSelect(page).selectOption("en");

  // The page follows the choice without a reload: the sidebar's group heading
  // and the row's own title are both copy, and both are in English now.
  await expect(navGroup(page, "Preferences")).toBeVisible();
  await expect(navTab(page, "General")).toBeVisible();
  await expect(languageRow(page)).toContainText("Language");

  // The document says which language it is in, so a screen reader and a
  // browser's own hyphenation both read it as English.
  await expect.poll(() => documentLang(page)).toBe("en");

  // And the choice is on the key the page already used.
  await expect.poll(() => storedLocale(page)).toBe("en");
});

test("the language choice survives the dialog being closed and opened again", async ({ page }) => {
  await openApp(page, "#session=A");
  await openSettings(page);
  await languageSelect(page).selectOption("en");
  await expect(navTab(page, "General")).toBeVisible();

  await closeSettings(page);
  await expect(settingsDialog(page)).toBeHidden();

  await openSettings(page);
  await expect(navTab(page, "General")).toBeVisible();
  await expect(languageRow(page)).toContainText("Language");
});

test("the settings search finds the language row", async ({ page }) => {
  await openApp(page, "#session=A");
  await openSettings(page);

  // Before the language work the search matched tab names only, so 「语言」
  // matched nothing and the sidebar answered 「没有匹配的设置」 to the one
  // question it existed to answer.
  await settingsSearch(page).fill("语言");
  await expect(navTab(page, "通用")).toBeVisible();
  await expect(languageRow(page)).toHaveAttribute("data-search-hit", "true");
  await expect(page.locator(".webui-settings-no-results")).toHaveCount(0);

  // And the same row is found by its English name, whichever language the
  // page is in. The page is still Chinese here, so the tab that owns the row
  // still reads 通用.
  await settingsSearch(page).fill("Language");
  await expect(navTab(page, "通用")).toBeVisible();
  await expect(languageRow(page)).toHaveAttribute("data-search-hit", "true");
});
