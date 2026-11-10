// The user menu's shutdown request, end to end against the built client.
//
// Stopping the server is the one action the page cannot take back, so the
// item asks first: the confirmation is what the person answers, and the
// request is what the answer asks for.
//
// The spec stops at the confirmation. The request itself ends the server the
// suite runs against, so a spec that confirmed it would take the suite down
// with it.

import { expect } from "@playwright/test";

import { openApp, test } from "./harness.mjs";

test("the user menu asks before it stops the server", async ({ page }) => {
  await openApp(page);

  // The rail has two triggers for the same menu: the expanded row and the
  // collapsed icon. Which one is rendered is the viewport's business, so the
  // spec takes whichever is there.
  await page
    .locator(
      '[data-testid="sidebar-user-menu-trigger"], [data-testid="sidebar-user-menu-trigger-rail"]',
    )
    .first()
    .click();
  await page.locator('[data-testid="user-menu-shutdown"]').click();

  await expect(page.getByRole("alertdialog")).toBeVisible();
  await expect(page.getByText("关闭本地 WebUI 服务")).toBeVisible();
});
