// The shell's layout at every width the contract's matrix covers.
//
// One screenshot per width, of the same surfaces the shell baseline already
// covers: the rail, the conversation column and the composer, and the
// workspace panel in both of its forms.
//
// The geometry assertions live in `responsive-layout.spec.mjs`, and they say
// what the shell promises. These say what it looks like while keeping those
// promises, so a change that fixes the squeeze and ruins the picture is still
// visible in review.
//
// The matrix covers the widths where the contract changes shape: the
// workspace panel is a column at 1024 and an overlay at 768; the navigation
// rail is a column at 640 and a drawer below it. 900 is in the matrix because
// it is the tightest column form there is — the conversation is at its floor
// with the workspace panel still standing beside it.

import { expect } from "@playwright/test";

import { configureFixture, openApp, screenshotOptions, test } from "./harness.mjs";

/** The widths the contract's matrix covers. */
const WIDTHS = [1440, 1280, 1024, 900, 768, 640, 480];

/**
 * The workspace panel in both of its forms: a column beside the conversation
 * while the surface can hold both floors, and an overlay over it when it
 * cannot. The two widths are on either side of that boundary with the
 * navigation rail expanded.
 */
const PANEL_WIDTHS = [1440, 1024, 768];

for (const width of WIDTHS) {
  test(`the shell at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await configureFixture(page, () => undefined);
    await openApp(page, "#session=A");
    await expect(page.locator("#webui-root")).toHaveScreenshot(`shell-at-${width}.png`, screenshotOptions);
  });
}

for (const width of PANEL_WIDTHS) {
  test(`the workspace panel at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await configureFixture(page, () => undefined);
    await openApp(page, "#session=A");
    await page.getByTestId("workspace-panel-controls").getByRole("button", { name: "浏览器" }).click();
    await expect(page.getByTestId("workspace-panel")).toBeVisible();
    await expect(page.locator("#webui-root")).toHaveScreenshot(`workspace-panel-at-${width}.png`, screenshotOptions);
  });
}
