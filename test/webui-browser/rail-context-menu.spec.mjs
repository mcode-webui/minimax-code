// The session context menu, end to end against the built client.
//
// The unit suite (`rail-context-menu.test.ts`) pins the wiring inside
// `SessionRail.tsx` as source assertions because a node environment cannot
// fire events. What only a real browser can prove:
//
//   1. A right-click on a session row OPENS the menu — in the flat views
//      (收藏 / 运行中 / 未读) as well as the projects view. The flat views were
//      the dead half: their rows had no binding and their branch rendered no
//      portal, so the right-click did nothing at all.
//   2. Clicking an item runs the action, not just the paint: the star item
//      writes the overlay and the row's mark appears; the unstar item in the
//      favourites view removes the row from the filtered list.
//   3. The menu closes on an outside click and on Escape.
//   4. Opened near the viewport bottom, the menu stays inside the viewport.
//
// The stars view stands in for all three flat views: they share one early
// return, one `WebuiSessionList` call and one row shape, so a binding that
// works there works in 运行中 and 未读 by construction. Forcing a running or
// unread session through the fixture's event pipeline would test that
// pipeline, not the menu. The horizontal clamp is covered by the
// `placeWebuiContextMenu` unit tests; the vertical flip is exercised here
// because only the real layout puts a 390px menu under a 480px viewport.

import { expect } from "@playwright/test";

import { openApp, test } from "./harness.mjs";

const SESSION_STARS = "mavis-webui-session-stars:v1";

test.beforeEach(async ({ page }) => {
  page.on("pageerror", (error) => console.error("BROWSER_PAGE_ERROR", error.stack ?? error.message));
  page.on("console", (message) => { if (message.type() === "error") console.error("BROWSER_CONSOLE_ERROR", message.text()); });
});

/** Seeds the favourites overlay before the app boots, the way a returning user has them. */
async function seedStars(page, sessions = {}) {
  await page.addInitScript(
    ([key, value]) => window.localStorage.setItem(key, value),
    [SESSION_STARS, JSON.stringify(sessions)],
  );
}

function sessionRow(page, sessionId) {
  return page.locator(`[data-webui-session-link="${sessionId}"]`);
}

function viewTab(page, view) {
  return page.locator(`[data-webui-rail-view="${view}"]`);
}

function contextMenu(page) {
  return page.locator('[data-webui-context-menu="true"]');
}

/** The menu item button by its exact label — the items are plain buttons, not menuitem roles. */
function menuItem(page, label) {
  return page.locator(".webui-context-menu-item", { hasText: new RegExp(`^${label}$`, "u") });
}

/**
 * Right-click a session row the way a user does: on the link, near its left
 * end. The projects row's hover action strip is `position: absolute` over the
 * right-hand end and still takes the hit at `opacity: 0`, so a centre click
 * can land on a strip button instead of the link.
 */
async function rightClickSession(page, sessionId) {
  await sessionRow(page, sessionId).first().click({ button: "right", position: { x: 40, y: 16 } });
}

test("the projects view opens the menu on a right-click", async ({ page }) => {
  await openApp(page, "#session=A");

  await rightClickSession(page, "A");
  await expect(contextMenu(page)).toBeVisible();
  // The menu the projects view has always offered: pin, star, rename, archive,
  // fork ×2, show-in-folder, copy (submenu parent), export, feedback, delete.
  // Counting the items rather than naming one keeps a future item from
  // silently dropping out of the check. (The submenu's own items render only
  // on hover, so they are not part of this count.)
  await expect(contextMenu(page).locator(".webui-context-menu-item")).toHaveCount(11);
  await expect(menuItem(page, "删除")).toBeEnabled();
});

test("the star item actually stars the session, not just closes the menu", async ({ page }) => {
  await openApp(page, "#session=A");

  await rightClickSession(page, "A");
  await menuItem(page, "收藏").click();

  // The menu is gone AND the action happened: the standing mark appears on the
  // row and the overlay the app re-reads at boot carries the star. Wrong when:
  // the item closes the menu without calling back, which draws a menu that
  // does nothing — the failure mode this spec exists to catch.
  await expect(contextMenu(page)).toHaveCount(0);
  await expect(sessionRow(page, "A").locator('[data-webui-star-mark="true"]')).toBeVisible();
  expect(await page.evaluate((key) => window.localStorage.getItem(key), SESSION_STARS)).toContain('"A":true');
});

test("the favourites view opens the menu its rows were missing", async ({ page }) => {
  await seedStars(page, { B: true });
  await openApp(page, "#session=A");

  await viewTab(page, "stars").click();
  await expect(sessionRow(page, "B")).toBeVisible();

  // The row this view renders is WebuiSessionList's own <a>; before the fix
  // this right-click was a complete no-op and the native browser menu showed.
  await rightClickSession(page, "B");
  await expect(contextMenu(page)).toBeVisible();
  // Same builder as the projects view, so the label follows the row's state:
  // B is starred, so the item says 取消收藏 and not 收藏.
  await expect(menuItem(page, "取消收藏")).toBeEnabled();
});

test("the unstar item removes the row from the favourites view", async ({ page }) => {
  await seedStars(page, { B: true });
  await openApp(page, "#session=A");
  await viewTab(page, "stars").click();

  await rightClickSession(page, "B");
  await menuItem(page, "取消收藏").click();

  // The filter recomputed from the new overlay: B is gone and the view says
  // so, rather than keeping a stale row painted under a star it no longer has.
  await expect(sessionRow(page, "B")).toHaveCount(0);
  await expect(page.getByText("没有收藏的会话")).toBeVisible();
});

test("a click outside the menu closes it", async ({ page }) => {
  await openApp(page, "#session=A");

  await rightClickSession(page, "A");
  await expect(contextMenu(page)).toBeVisible();

  // On the main column, clear of the rail and of the menu itself. The menu
  // listens for mousedown, so this is the exact event the outside-close
  // policy subscribes to.
  await page.mouse.click(720, 450);
  await expect(contextMenu(page)).toHaveCount(0);
});

test("Escape closes the menu", async ({ page }) => {
  await openApp(page, "#session=A");

  await rightClickSession(page, "A");
  await expect(contextMenu(page)).toBeVisible();

  await page.keyboard.press("Escape");
  await expect(contextMenu(page)).toHaveCount(0);
});

test("a menu opened near the viewport bottom flips and stays inside the viewport", async ({ page }) => {
  await page.setViewportSize({ width: 720, height: 480 });
  await openApp(page, "#session=A");

  // The click point at the row's bottom edge, straight from the layout: with a
  // 480px viewport the session menu (≈390px tall) cannot fit below any rail
  // row, so this hits the flip path for real rather than by arithmetic. The
  // scrollIntoView first keeps the row on screen if the shorter viewport has
  // pushed it below the rail's scroll fold.
  await sessionRow(page, "A").scrollIntoViewIfNeeded();
  const box = await sessionRow(page, "A").boundingBox();
  expect(box, "the session row did not lay out").not.toBeNull();
  const clickY = box.y + box.height - 4;
  await page.mouse.click(box.x + 40, clickY, { button: "right" });

  const menu = contextMenu(page);
  await expect(menu).toBeVisible();
  const menuBox = await menu.boundingBox();
  expect(menuBox, "the menu did not lay out").not.toBeNull();
  // Containment is the user-visible contract: no edge of the menu may leave
  // the viewport, whichever way the flip and the clamps resolved it.
  expect(menuBox.y).toBeGreaterThanOrEqual(0);
  expect(menuBox.x).toBeGreaterThanOrEqual(0);
  expect(menuBox.y + menuBox.height).toBeLessThanOrEqual(480);
  expect(menuBox.x + menuBox.width).toBeLessThanOrEqual(720);
  // And the flip itself happened: the menu's top edge sits above the pointer
  // rather than the menu extending below it.
  expect(menuBox.y).toBeLessThan(clickY);
});
