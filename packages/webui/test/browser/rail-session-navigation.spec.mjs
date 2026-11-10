// The rail's session links, end to end against the built client.
//
// A rail session row is a plain `#session=<id>` anchor, so selecting a session
// runs through the hash subscription inside `useSelectedSessionId` rather than
// through a setter the shell holds. Clicking the link of the session that is
// *already* selected changes nothing that subscription can observe: the hash
// stays the same, so no `hashchange` fires, the selection does not change, and
// the shell never hears that the user asked for the conversation -- it keeps
// the surface it was showing.
//
// The symptom is the 远程 page: open it, click the session you are already in,
// and the page stays put.
//
// The session link is clicked by dispatching the event rather than by moving
// the pointer. The rail row carries its own action buttons (置顶, 归档, 更多) on
// the right, and they intercept the pointer at the link's centre -- the same
// spot a user has to aim around.

import { expect } from "@playwright/test";

import { openApp, test } from "./harness.mjs";

function sessionLink(page, sessionId) {
  return page.locator(`[data-webui-session-link="${sessionId}"]`);
}

function conversation(page) {
  return page.locator('[data-webui-session-layout="true"]');
}

function remotePage(page) {
  return page.locator('[data-webui-component="remote-page"]');
}

test("clicking the selected session's rail link returns to the conversation", async ({ page }) => {
  await openApp(page, "#session=A");

  await expect(sessionLink(page, "A")).toBeVisible();
  await expect(conversation(page)).toBeVisible();

  await page.locator('[data-webui-nav-item="远程"]').click();
  await expect(remotePage(page)).toBeVisible();
  await expect(conversation(page)).toHaveCount(0);

  // The same session, clicked again. The hash does not change, so this click
  // is the only signal the shell gets.
  await sessionLink(page, "A").dispatchEvent("click");

  await expect(remotePage(page)).toHaveCount(0);
  await expect(conversation(page)).toBeVisible();
});
