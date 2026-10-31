// The transfer entry paths — export and import — end to end against the built
// client (T07's verification seam: "rail/archive/import/export browser entry
// paths").
//
// Both halves of the round trip are HTTP, not WebSocket: the export navigates to
// `GET /session-transfer` and the import posts to `POST /session-import`. The
// browser harness serves no HTTP, so this case intercepts those two requests and
// says so — what it proves is the *entry path*: which request the rail's menu and
// the import button build, with which credential and which file bytes. The routes
// themselves are covered over a real `WebuiService` and loopback HTTP in
// `session-transfer-route.test.ts`, and the client adapters in
// `session-transfer-download.test.ts`.

import { expect } from "@playwright/test";

import { configureFixture, openApp, test } from "./harness.mjs";

const TRANSFER_FORMAT = "mcode-webui-session-transfer@1";

const sessionRow = (page, sessionId) =>
  page.locator(`[data-webui-session-link="${sessionId}"]`);
const menuItem = (page, label) =>
  page.locator(".webui-context-menu-item", {
    hasText: new RegExp(`^${label}$`, "u"),
  });

test("the rail's export menu and import button reach the transfer routes", async ({
  page,
}) => {
  await configureFixture(page, () => undefined);

  const exportUrls = [];
  const importRequests = [];
  await page.route("**/session-transfer**", async (route) => {
    exportUrls.push(route.request().url());
    await route.fulfill({
      status: 200,
      headers: {
        "content-type": "application/json",
        "content-disposition": 'attachment; filename="transfer.json"',
      },
      body: JSON.stringify({ format: TRANSFER_FORMAT }),
    });
  });
  await page.route("**/session-import**", async (route) => {
    importRequests.push({
      url: route.request().url(),
      body: route.request().postData() ?? "",
    });
    await route.fulfill({
      status: 200,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionId: "imported-1" }),
    });
  });

  await openApp(page);

  // 1. Export: the rail's context menu builds the route URL with the session id
  //    and the injected credential, and the browser takes the download.
  const download = page.waitForEvent("download");
  await sessionRow(page, "B")
    .first()
    .click({ button: "right", position: { x: 40, y: 16 } });
  await menuItem(page, "导出会话").click();
  const file = await download;
  expect(file.suggestedFilename()).toBe("transfer.json");
  await expect.poll(() => exportUrls.length).toBeGreaterThan(0);
  const exported = new URL(exportUrls.at(-1));
  expect(exported.pathname).toBe("/session-transfer");
  expect(exported.searchParams.get("sessionId")).toBe("B");
  expect(exported.searchParams.get("token")).toBe("synthetic-token");

  // 2. Import: the file the user picked is what gets posted. The picker is the
  //    rail's visually hidden file input (the row is the visible button), so the
  //    case sets the file on it directly — the change handler that reads and
  //    uploads is the production one.
  await page
    .locator('[data-webui-session-import-input="true"]')
    .setInputFiles({
      name: "transfer.json",
      mimeType: "application/json",
      buffer: Buffer.from(JSON.stringify({ format: TRANSFER_FORMAT })),
    });
  await expect.poll(() => importRequests.length).toBeGreaterThan(0);
  const imported = new URL(importRequests.at(-1).url);
  expect(imported.pathname).toBe("/session-import");
  expect(imported.searchParams.get("token")).toBe("synthetic-token");
  // The picked file travelled: the body carries its bytes, and the format tag is
  // what the importer checks before it uploads.
  expect(importRequests.at(-1).body).toContain(TRANSFER_FORMAT);
});
