// The pages that render the content page frame, measured after the migration
// (#291, ADR 0028 § Shared contracts).
//
// The frame's own claims are tested without a browser in `content-page.test.ts`.
// What a string cannot show is what the AC asks for: over each migrated page's
// enumerated states — two viewports, both themes — nothing is squeezed, deformed,
// truncated or reflowed, and the page keeps exactly one scroll boundary, on the
// element the contract names rather than on whatever happens to overflow.
//
// The theme is switched the way a user switches it, through 设置 › 通用, because
// the suite pins `colorScheme: "light"` and the client's theme is an explicit
// preference rather than a media query.
//
// 远程 is checked only when the runtime exposes it: the rail row is disabled when
// the runtime has no remote route, and a disabled row is not a page.

import { expect } from "@playwright/test";

import { configureFixture, openApp, test } from "./harness.mjs";

const VIEWPORTS = [
  { name: "wide", width: 1440, height: 900 },
  { name: "narrow", width: 390, height: 844 },
];
const THEMES = ["light", "dark"];

test.beforeEach(async ({ page }) => {
  page.on("pageerror", (error) => console.error("BROWSER_PAGE_ERROR", error.stack ?? error.message));
  await configureFixture(page, () => undefined);
  await openApp(page, "#session=A");
});

const settingsDialog = (page) => page.locator('[role="dialog"][aria-label="设置"]');

/** Switches the client theme through the settings page, the way a user does. */
async function setTheme(page, theme) {
  await page.getByTestId("sidebar-user-menu-trigger").click();
  await page.getByTestId("user-menu-settings").click();
  await expect(settingsDialog(page)).toBeVisible();
  await page.locator('[data-testid="mavis-settings-appearance-row"] .mavis-settings-theme-option', {
    hasText: theme === "dark" ? "深色模式" : "浅色模式",
  }).click();
  // The settings modal is a managed layer now, so one Escape closes it.
  await page.keyboard.press("Escape");
  await expect(settingsDialog(page)).toHaveCount(0);
  const isDark = await page.evaluate(() => document.documentElement.classList.contains("dark"));
  expect(isDark, `${theme} theme applied`).toBe(theme === "dark");
}

/**
 * What the frame promises about the page it holds.
 *
 * The scroll boundary is counted by contract — the elements that declare
 * `overflow-y: auto` — not by whether today's content happens to overflow: a page
 * whose content fits still owns exactly one boundary.
 */
async function measure(page, selector) {
  return page.evaluate((pageSelector) => {
    const section = document.querySelector(pageSelector);
    if (!section) return null;
    const header = section.querySelector("header");
    const body = section.lastElementChild;
    const scrollers = [section, ...section.querySelectorAll("*")].filter(
      (node) => getComputedStyle(node).overflowY === "auto",
    );
    const heading = header?.querySelector("h1");
    const headingBox = heading?.getBoundingClientRect();
    const headerBox = header?.getBoundingClientRect();
    const bodyBox = body?.getBoundingClientRect();
    return {
      pageScrolls: getComputedStyle(section).overflowY === "auto",
      scrollingNodes: scrollers.length,
      headerHeight: headerBox ? Math.round(headerBox.height) : null,
      headerBorder: header ? getComputedStyle(header).borderBottomWidth : null,
      titlePresent: Boolean(heading),
      // A clipped title loses height; a squeezed one loses width.
      titleHeight: headingBox ? Math.round(headingBox.height) : null,
      titleWidth: headingBox ? Math.round(headingBox.width) : null,
      headerWidth: headerBox ? Math.round(headerBox.width) : null,
      horizontalOverflow: section.scrollWidth - section.clientWidth,
      bodyBelowHeader: headerBox && bodyBox ? bodyBox.top >= headerBox.bottom - 1 : null,
      bodyHasHeight: bodyBox ? Math.round(bodyBox.height) : null,
    };
  }, selector);
}

for (const theme of THEMES) {
  for (const viewport of VIEWPORTS) {
    test(`定时任务 holds the frame at ${viewport.name} / ${theme}`, async ({ page }) => {
      await page.setViewportSize({ width: 1440, height: 900 });
      await openApp(page, "#session=A");
      await setTheme(page, theme);
      await page.getByRole("button", { name: /定时任务/u }).first().click();
      // The page is measured at the enumerated viewport; it is *reached* at the wide
      // one, where the rail's rows are on screen.
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      const panel = page.locator('[data-webui-component="scheduling-panel"]');
      await expect(panel).toBeVisible();

      const measured = await measure(page, '[data-webui-component="scheduling-panel"]');
      expect(measured, "panel rendered").not.toBeNull();
      expect(measured?.pageScrolls, "the page itself does not scroll").toBe(false);
      expect(measured?.scrollingNodes, "exactly one scroll boundary").toBe(1);
      expect(measured?.headerHeight ?? 0, "the header keeps its height").toBeGreaterThan(40);
      expect(measured?.titleHeight ?? 0, "the title is not clipped vertically").toBeGreaterThanOrEqual(18);
      expect(measured?.titleWidth ?? 0, "the title keeps its width").toBeGreaterThan(20);
      expect(measured?.horizontalOverflow ?? 1, "no sideways overflow").toBeLessThanOrEqual(0);
      expect(measured?.bodyBelowHeader, "the body sits below the header").toBe(true);
      expect(measured?.bodyHasHeight ?? 0, "the body fills what is left").toBeGreaterThan(0);
    });

    test(`远程 holds the frame at ${viewport.name} / ${theme}`, async ({ page }) => {
      await page.setViewportSize({ width: 1440, height: 900 });
      await openApp(page, "#session=A");
      await setTheme(page, theme);

      const railRow = page.getByRole("button", { name: /^远程$/u }).first();
      // The runtime decides whether the client has a remote page; a disabled row is
      // not a page, so there is nothing to measure and nothing to claim.
      test.skip(await railRow.isDisabled(), "the runtime exposes no remote route in this fixture");
      await railRow.click();
      await expect(page.getByTestId("remote-page")).toBeVisible();
      await page.setViewportSize({ width: viewport.width, height: viewport.height });

      const measured = await measure(page, '[data-testid="remote-page"]');
      expect(measured?.pageScrolls, "the remote page does not scroll as a page").toBe(false);
      // Its header is a tab bar rather than a title row: it keeps its own height.
      expect(measured?.headerHeight ?? 0).toBeGreaterThanOrEqual(44);
      expect(measured?.horizontalOverflow ?? 1, "no sideways overflow").toBeLessThanOrEqual(0);
      expect(measured?.bodyHasHeight ?? 0, "the body fills what is left").toBeGreaterThan(0);

      // The SSH tab renders the third page that shares the frame.
      const sshTab = page.getByTestId("remote-page-tab-ssh");
      test.skip((await sshTab.count()) === 0, "the runtime exposes no SSH tab in this fixture");
      await sshTab.click();
      const sshPanel = page.locator('[data-webui-component="ssh-panel"]');
      await expect(sshPanel).toBeVisible();
      const ssh = await measure(page, '[data-webui-component="ssh-panel"]');
      expect(ssh?.pageScrolls, "the SSH page does not scroll as a page").toBe(false);
      expect(ssh?.scrollingNodes, "exactly one scroll boundary").toBe(1);
      expect(ssh?.titleHeight ?? 0, "the SSH title is not clipped").toBeGreaterThanOrEqual(18);
      expect(ssh?.horizontalOverflow ?? 1, "no sideways overflow").toBeLessThanOrEqual(0);
      expect(ssh?.bodyBelowHeader, "the body sits below the header").toBe(true);
    });
  }
}
