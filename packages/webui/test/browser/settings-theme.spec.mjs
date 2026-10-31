// Settings › 通用 › Appearance — the three theme buttons (浅色模式 / 深色模式 /
// 跟随系统), driven the way a user drives them, against the built client.
//
// The roadmap's P-zone row for 跟随系统 is a screenshot-era "未见", and everything
// the suite could say about it until now was structural: `resolveThemePreference`
// has four unit assertions on its input mapping, and the buttons exist in the
// DOM. Neither is the feature. The feature is a round trip through pieces the
// unit suite cannot mount: the `matchMedia("(prefers-color-scheme: dark)")`
// listener the modal registers, the `change` event the browser fires on it when
// the OS scheme flips, and the effect that toggles `dark`/`light` on
// `<html>` in response. That is what these tests exercise — with
// `page.emulateMedia`, which is the only lever, because the suite pins
// `colorScheme: "light"` globally (playwright.config.mjs): a test that never
// emulates is always light, and "default is light" must never be mistaken for
// "following works".
//
// One deliberate omission: no assertion here closes the modal and flips the OS
// scheme. While closed, `<html>` theming rests on `UserMenu` keeping
// `<SettingsModal open={false}>` mounted (hooks stay live across `return null`),
// which is an implementation detail of the shell rather than a contract this
// row owns — see the PR description for the dev-probe result.

import { expect } from "@playwright/test";

import { openApp, test } from "./harness.mjs";

test.beforeEach(async ({ page }) => {
  page.on("pageerror", (error) => console.error("BROWSER_PAGE_ERROR", error.stack ?? error.message));
  page.on("console", (message) => { if (message.type() === "error") console.error("BROWSER_CONSOLE_ERROR", message.text()); });
});

function settingsDialog(page) {
  return page.locator('[role="dialog"][aria-label="设置"]');
}

/** Opens settings the way a user does: user menu, then 设置. */
async function openSettings(page) {
  await page.locator('[data-testid="sidebar-user-menu-trigger"]').click();
  await page.locator('[data-testid="user-menu-settings"]').click();
  await expect(settingsDialog(page)).toBeVisible();
}

function themeOption(page, label) {
  return page.locator('[data-testid="mavis-settings-appearance-row"] .mavis-settings-theme-option', { hasText: label });
}

/** The two classes the theme effect owns on `<html>`, as booleans.
 *
 * `classList.toggle(name, on)` writes exactly `dark` and `light` and nothing
 * else, so presence/absence is the honest reading — an exact class-string match
 * would break the moment any unrelated system put a class on the document
 * element. */
function htmlThemeClasses(page) {
  return page.evaluate(() => ({
    dark: document.documentElement.classList.contains("dark"),
    light: document.documentElement.classList.contains("light"),
  }));
}

/** The persisted preference string (`webui-theme`), not the resolved theme. */
function storedTheme(page) {
  return page.evaluate(() => localStorage.getItem("webui-theme"));
}

test("跟随系统 follows the OS color scheme while it is the selected preference", async ({ page }) => {
  await openApp(page, "#session=A");
  await openSettings(page);
  const row = page.locator('[data-testid="mavis-settings-appearance-row"]');
  await expect(row).toBeVisible();

  // Fresh context → `webui-theme` defaults to "light", so selecting 跟随系统
  // while the harness pins light changes nothing on screen yet — the row's own
  // selection marker is what proves the click landed.
  await themeOption(page, "跟随系统").click();
  await expect(themeOption(page, "跟随系统")).toHaveAttribute("aria-pressed", "true");

  // Dark, then back to light. `expect.poll` carries the whole async chain —
  // the emulated change event, the modal's matchMedia listener, the setState,
  // the effect — so no sleeps and no order coupling between emulation and
  // assertion.
  await page.emulateMedia({ colorScheme: "dark" });
  await expect.poll(() => htmlThemeClasses(page)).toEqual({ dark: true, light: false });

  await page.emulateMedia({ colorScheme: "light" });
  await expect.poll(() => htmlThemeClasses(page)).toEqual({ dark: false, light: true });
});

test("a manual choice overrides the OS scheme", async ({ page }) => {
  await openApp(page, "#session=A");
  await openSettings(page);

  // Control leg first: under 跟随系统 the very flip used below moves the page.
  // This is what keeps the final assertion honest — without it, "still dark
  // after flipping to light" would also pass with a listener that never fired,
  // because the state it asserts never changes in the first place.
  await themeOption(page, "跟随系统").click();
  await page.emulateMedia({ colorScheme: "dark" });
  await expect.poll(() => htmlThemeClasses(page)).toEqual({ dark: true, light: false });

  // Now pin dark manually — the row's selection must move with the click, or
  // the rest of the test would be re-proving the system leg under a stale
  // preference.
  await themeOption(page, "深色模式").click();
  await expect(themeOption(page, "深色模式")).toHaveAttribute("aria-pressed", "true");
  await expect(themeOption(page, "跟随系统")).toHaveAttribute("aria-pressed", "false");

  // The override itself: OS says light now, the app stays dark. Waiting for
  // the page's own matchMedia to report the flip first means the change event
  // has been dispatched to listeners before the final poll samples, so a
  // broken override (preference still resolving through the system) is seen
  // as light and times out, not missed.
  await page.emulateMedia({ colorScheme: "light" });
  await expect.poll(() => page.evaluate(() => window.matchMedia("(prefers-color-scheme: dark)").matches)).toBe(false);
  await expect.poll(() => htmlThemeClasses(page)).toEqual({ dark: true, light: false });
});

test("the clicked preference persists to localStorage as the preference, not the resolved theme", async ({ page }) => {
  await openApp(page, "#session=A");
  await openSettings(page);

  // With the OS dark, 跟随系统 resolves to a dark page — but what must land in
  // `webui-theme` is "system". Persisting the resolved "dark" here would turn
  // the stored preference into a snapshot of tonight's OS state, and tomorrow
  // morning's boot would stop following the OS with no UI to show for it.
  await page.emulateMedia({ colorScheme: "dark" });
  await themeOption(page, "跟随系统").click();
  await expect.poll(() => storedTheme(page)).toBe("system");

  await themeOption(page, "深色模式").click();
  await expect.poll(() => storedTheme(page)).toBe("dark");

  await themeOption(page, "浅色模式").click();
  await expect.poll(() => storedTheme(page)).toBe("light");
});
