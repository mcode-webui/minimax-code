// The archived-session entry surface, end to end against the built client
// (T07's verification seam: "rail/archive/import/export browser entry paths").
//
// Archiving is one operation in both directions (`{ id }` archives,
// `{ id, archived: false }` takes it back), and the archived page reads the same
// `listSessions` call with `onlyArchived`. These cases pin that the rail's menu,
// the archived settings page and the unarchive button all go through the Sessions
// owner rather than each holding their own path.

import { expect } from "@playwright/test";

import { configureFixture, openApp, test } from "./harness.mjs";

const sessionRow = (page, sessionId) =>
  page.locator(`[data-webui-session-link="${sessionId}"]`);
const menuItem = (page, label) =>
  page.locator(".webui-context-menu-item", {
    hasText: new RegExp(`^${label}$`, "u"),
  });
const settingsDialog = (page) => page.locator('[role="dialog"][aria-label="设置"]');
const archivedPage = (page) => page.getByTestId("settings-archived-page");

const archived = (page) => page.evaluate(() => window.__fixture.archived());
const requests = (page, operation) =>
  page.evaluate(
    (name) =>
      window.__fixture.requests.filter((request) => request.operation === name).length,
    operation,
  );
const lastBody = (page, operation) =>
  page.evaluate(
    (name) =>
      window.__fixture.requests.filter((request) => request.operation === name).at(-1)
        ?.body ?? null,
    operation,
  );

/** Opens settings the way a user does: the user menu, then 设置. */
async function openSettings(page) {
  await page.locator('[data-testid="sidebar-user-menu-trigger"]').click();
  await page.locator('[data-testid="user-menu-settings"]').click();
  await expect(settingsDialog(page)).toBeVisible();
}

test("the rail's menu archives a session and the archived page takes it back", async ({
  page,
}) => {
  await configureFixture(page, () => undefined);
  await openApp(page);
  await expect(sessionRow(page, "B")).toHaveCount(1);

  // 1. Archive from the rail's own context menu.
  await sessionRow(page, "B")
    .first()
    .click({ button: "right", position: { x: 40, y: 16 } });
  await menuItem(page, "归档").click();
  await expect.poll(() => requests(page, "archiveSession")).toBeGreaterThan(0);
  expect(await lastBody(page, "archiveSession")).toEqual({ id: "B" });
  await expect.poll(() => archived(page)).toEqual(["B"]);
  // The rail stops listing it, because the reload it triggered left it out.
  await expect(sessionRow(page, "B")).toHaveCount(0);

  // 2. The archived settings page reads it through the same owner.
  await openSettings(page);
  await page.locator('[data-menu-key="archived"]').click();
  await expect(archivedPage(page)).toBeVisible();
  await expect(archivedPage(page)).toContainText("Synthetic session B");

  // 3. Unarchive from that page: the same operation, the other direction.
  await archivedPage(page)
    .getByRole("button", { name: "取消归档" })
    .first()
    .click();
  await expect.poll(() => archived(page)).toEqual([]);
  expect(await lastBody(page, "archiveSession")).toEqual({
    id: "B",
    archived: false,
  });
  await expect(archivedPage(page)).not.toContainText("Synthetic session B");
});
