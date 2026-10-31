// The layout adapts to the width it has (ADR 0025).
//
// These assertions are about geometry, not pixels. They check that the shell
// keeps its promises at every width in the contract's matrix: nothing scrolls
// sideways, the conversation column keeps its floor, the navigation rail
// becomes a drawer below the compact width, the header row's three parts do
// not overlap, the composer's controls never share a line they cannot both fit
// on, and the progress card keeps the gutter it has always had without
// becoming a column of the surface.
//
// A screenshot would only say how the shell looks at one width on one machine.
// These say what the shell promises.

import { expect } from "@playwright/test";

import { configureFixture, openApp, test } from "./harness.mjs";

/** The widths the contract's matrix covers. */
const VIEWPORTS = [
  { width: 1440, height: 900 },
  { width: 1280, height: 900 },
  { width: 1024, height: 900 },
  { width: 900, height: 900 },
  { width: 768, height: 900 },
  { width: 640, height: 900 },
  { width: 480, height: 900 },
];

/** The floors the contract gives the reading column and the tool panel. */
const CONVERSATION_FLOOR = 320;
const PANEL_FLOOR = 360;

/** The width below which the navigation rail is a drawer rather than a column. */
const COMPACT = 640;

const openPanel = async (page) => {
  await page.getByTestId("workspace-panel-controls").getByRole("button", { name: "浏览器" }).click();
  await expect(page.getByTestId("workspace-panel")).toBeVisible();
};

/** How far the document scrolls sideways. Zero is the promise. */
const horizontalOverflow = (page) =>
  page.evaluate(() => {
    const root = document.documentElement;
    return root.scrollWidth - root.clientWidth;
  });

/** The surface's width: the space the rail leaves behind. */
const surfaceWidth = (page) =>
  page.evaluate(() => {
    const surface = document.querySelector('[data-webui-shell-region="surface"]');
    return surface ? Math.round(surface.getBoundingClientRect().width) : 0;
  });

test.describe("the layout adapts to the width it has", () => {
  for (const viewport of VIEWPORTS) {
    test(`the shell keeps its promises at ${viewport.width}px`, async ({ page }) => {
      await page.setViewportSize(viewport);
      await configureFixture(page, () => undefined);
      await openApp(page, "#session=A");

      // Nothing scrolls sideways. This is the squeeze in its plainest form:
      // a column that cannot shrink is a column that pushes the document
      // wider than the window.
      expect(await horizontalOverflow(page)).toBeLessThanOrEqual(1);

      const rail = page.locator(".webui-rail");
      const surface = page.locator('[data-webui-shell-region="surface"]');
      const railBox = await rail.boundingBox();
      const surfaceBox = await surface.boundingBox();
      expect(railBox).not.toBeNull();
      expect(surfaceBox).not.toBeNull();

      if (viewport.width < COMPACT) {
        // The rail is a drawer: it floats above the surface and takes none of
        // its width, so the surface starts at the window's edge.
        expect(railBox.x + railBox.width).toBeLessThanOrEqual(1);
        expect(surfaceBox.x).toBeLessThanOrEqual(1);
      } else {
        // The rail is a column and the surface begins where it ends.
        expect(railBox.width).toBeGreaterThan(0);
        expect(surfaceBox.x).toBeGreaterThanOrEqual(railBox.x + railBox.width - 1);
      }

      // The conversation column keeps its floor. It is the reading surface, so
      // it is the thing that keeps its space when space runs short.
      const column = await page.locator(".webui-conversation-column").boundingBox();
      expect(column.width, `conversation column at ${viewport.width}px`)
        .toBeGreaterThanOrEqual(CONVERSATION_FLOOR - 1);

      // The composer's toolbar is one row at every width. It used to wrap,
      // and whether it wrapped was decided by a threshold that had nothing to
      // do with what the row needed.
      const toolbar = await page.locator('[data-webui-composer-toolbar="true"]').boundingBox();
      const permission = await page.getByTestId("composer-permission-mode").boundingBox();
      expect(toolbar.height, `composer toolbar height at ${viewport.width}px`)
        .toBeLessThanOrEqual(48);
      expect(permission.y, `permission control at ${viewport.width}px`)
        .toBeGreaterThanOrEqual(toolbar.y - 1);
      expect(permission.y + permission.height, `permission control at ${viewport.width}px`)
        .toBeLessThanOrEqual(toolbar.y + toolbar.height + 1);
    });
  }

  test("the header row's parts do not overlap each other", async ({ page }) => {
    await page.setViewportSize({ width: 480, height: 900 });
    await configureFixture(page, () => undefined);
    await openApp(page, "#session=A");

    // The rail's toggle, the session title and the panel controls share one
    // row. They used to be three absolutely positioned pieces of geometry
    // whose offsets had to agree, and in the rail's drawer form they did not.
    const tools = await page.locator(".webui-session-header-tools").boundingBox();
    const title = await page.locator('[data-webui-session-title="true"]').boundingBox();
    const actions = await page.locator(".webui-session-header-actions").boundingBox();

    expect(tools.x + tools.width).toBeLessThanOrEqual(title.x + 1);
    expect(title.x + title.width).toBeLessThanOrEqual(actions.x + 1);
  });

  test("the conversation column keeps the floor the contract gives it", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await configureFixture(page, () => undefined);
    await openApp(page, "#session=A");
    await openPanel(page);

    const panel = page.getByTestId("workspace-panel");
    const column = page.locator(".webui-conversation-column");

    // The surface is wide enough for both floors, so the panel is a column.
    await expect(panel).toHaveAttribute("data-webui-surface-tier", "split");
    expect((await column.boundingBox()).width).toBeGreaterThanOrEqual(CONVERSATION_FLOOR - 1);

    // Dragging the panel to its limit gives the conversation column exactly
    // its floor and not less: the panel may claim the surface's width less
    // the column's floor, and no more.
    const before = await panel.boundingBox();
    const handle = page.getByRole("separator", { name: "调整工作区面板宽度" });
    await expect(handle).toBeVisible();
    await page.mouse.move(before.x + 4, before.y + before.height / 2);
    await page.mouse.down();
    await page.mouse.move(before.x - 2000, before.y + before.height / 2);
    await page.mouse.up();
    await expect
      .poll(async () => (await panel.boundingBox()).width)
      .toBeGreaterThan(before.width + 40);

    const columnBox = await column.boundingBox();
    expect(columnBox.width).toBeGreaterThanOrEqual(CONVERSATION_FLOOR - 1);
    expect((await panel.boundingBox()).width).toBeGreaterThanOrEqual(PANEL_FLOOR - 1);
    expect(await horizontalOverflow(page)).toBeLessThanOrEqual(1);
  });

  test("narrowing the window hands the panel's width back to the conversation", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await configureFixture(page, () => undefined);
    await openApp(page, "#session=A");
    await openPanel(page);

    const panel = page.getByTestId("workspace-panel");
    const column = page.locator(".webui-conversation-column");
    await expect(panel).toHaveAttribute("data-webui-surface-tier", "split");

    // The window narrows after the panel was opened and measured. The panel
    // has to notice: a clamp that only ran while the pointer moved left the
    // panel holding a width the conversation could not afford.
    await page.setViewportSize({ width: 700, height: 900 });
    await expect(panel).toHaveAttribute("data-webui-surface-tier", "overlay");
    expect(await horizontalOverflow(page)).toBeLessThanOrEqual(1);
    // The conversation keeps the whole surface: the panel is an overlay now,
    // so it does not spend the surface's width.
    const columnBox = await column.boundingBox();
    const surfaceBox = await page.locator('[data-webui-shell-region="surface"]').boundingBox();
    expect(columnBox.width).toBeGreaterThanOrEqual(surfaceBox.width - 1);
  });

  test("the progress panel is a card over the conversation, not a column of the surface", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await configureFixture(page, () => undefined);
    await openApp(page, "#session=A");

    const motion = page.locator(".webui-progress-panel-motion");
    await expect(motion).toHaveClass(/is-open/);

    // The card is anchored to the window rather than to the surface, so the
    // surface's width does not decide where it stands.
    const style = await motion.evaluate((element) => {
      const computed = getComputedStyle(element);
      return { position: computed.position, right: computed.right };
    });
    expect(style.position, "the progress panel is a float over the conversation").toBe("fixed");
    expect(style.right, "the progress panel keeps its gutter from the window's edge").toBe("12px");

    // The card's width animates open, and the card is anchored by its right
    // edge, so the width is read once it has settled.
    await expect.poll(async () => Math.round((await motion.boundingBox()).width)).toBe(288);
    const box = await motion.boundingBox();
    // The document reserves a scrollbar gutter, so the box a fixed card is
    // placed against is the document's width rather than the window's inner
    // width: the reserved gutter is not page the card may use.
    const pageWidth = await page.evaluate(() => document.documentElement.offsetWidth);
    expect(Math.round(box.x + box.width), "the card sits against the page's right edge")
      .toBe(pageWidth - 12);

    // A column would take the surface's width away from the conversation. This
    // one takes none: the conversation is as wide as it would be with the card
    // closed.
    const column = await page.locator(".webui-conversation-column").boundingBox();
    expect(Math.round(column.width), "the card takes none of the surface's width")
      .toBe(await surfaceWidth(page));
  });

  test("the conversation keeps a gutter for the card while the window can spare it", async ({ page }) => {
    // The card floats over the conversation's right edge, so the conversation
    // keeps a gutter for it and the card lands in that gutter instead of on
    // top of the text.
    for (const width of [1440, 1280, 1080]) {
      await page.setViewportSize({ width, height: 900 });
      await configureFixture(page, () => undefined);
      await openApp(page, "#session=A");

      const gutter = await page.locator('[data-webui-session-layout="true"]')
        .evaluate((element) => getComputedStyle(element).paddingRight);
      expect(gutter, `the progress gutter at ${width}px`).toBe("312px");
    }

    // Below the width the conversation cannot spare the gutter without being
    // squeezed itself, so the card closes itself rather than sitting on the
    // text, and the conversation keeps its full width.
    for (const width of [1079, 1024, 768, 480]) {
      await page.setViewportSize({ width, height: 900 });
      await configureFixture(page, () => undefined);
      await openApp(page, "#session=A");

      const gutter = await page.locator('[data-webui-session-layout="true"]')
        .evaluate((element) => getComputedStyle(element).paddingRight);
      expect(gutter, `the progress gutter at ${width}px`).toBe("0px");
    }
  });

  test("a closed progress panel reserves no width at all", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await configureFixture(page, () => undefined);
    await openApp(page, "#session=A");

    const motion = page.locator(".webui-progress-panel-motion");
    await expect(motion).toHaveClass(/is-open/);
    const layout = page.locator('[data-webui-session-layout="true"]');
    expect(await layout.evaluate((element) => getComputedStyle(element).paddingRight)).toBe("312px");

    await page.getByTestId("workspace-panel-controls").getByRole("button", { name: "环境信息与进度" }).click();
    await expect(motion).not.toHaveClass(/is-open/);

    // The card's width animates to nothing and the gutter it had reserved goes
    // with it, so the conversation gets the space back.
    await expect.poll(async () => (await motion.boundingBox()).width).toBe(0);
    await expect
      .poll(async () => layout.evaluate((element) => getComputedStyle(element).paddingRight))
      .toBe("0px");
  });

  test("the progress panel and the workspace panel do not both claim the surface", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await configureFixture(page, () => undefined);
    await openApp(page, "#session=A");

    const motion = page.locator(".webui-progress-panel-motion");
    await expect(motion).toHaveClass(/is-open/);

    // Opening the workspace panel closes the progress panel: one tool region
    // gives way, the other takes the space.
    await openPanel(page);
    await expect(motion).not.toHaveClass(/is-open/);
    await expect.poll(async () => (await motion.boundingBox()).width).toBe(0);
  });

  test("the progress panel closes itself where the conversation cannot spare its gutter", async ({ page }) => {
    for (const width of [1079, 1024, 768, 480]) {
      await page.setViewportSize({ width, height: 900 });
      await configureFixture(page, () => undefined);
      await openApp(page, "#session=A");

      // The card floats over the conversation's right edge, and the
      // conversation keeps a gutter for it so that the card lands in the
      // gutter instead of on top of the text. Below the width the conversation
      // cannot spare that gutter, so the card takes itself away.
      const motion = page.locator(".webui-progress-panel-motion");
      await expect(motion).not.toHaveClass(/is-open/);
      await expect.poll(async () => (await motion.boundingBox()).width).toBe(0);

      // The control says so rather than pretending to work.
      const toggle = page.getByTestId("workspace-panel-controls").getByRole("button", { name: "环境信息与进度" });
      await expect(toggle).toHaveAttribute("aria-disabled", "true");
    }
  });

  test("a window that narrows past the width closes the panel for good", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await configureFixture(page, () => undefined);
    await openApp(page, "#session=A");

    const motion = page.locator(".webui-progress-panel-motion");
    await expect(motion).toHaveClass(/is-open/);

    // The window narrows: the card has nowhere to go but on top of the text,
    // so it takes itself away.
    await page.setViewportSize({ width: 1024, height: 900 });
    await expect(motion).not.toHaveClass(/is-open/);
    await expect.poll(async () => (await motion.boundingBox()).width).toBe(0);

    // It stays away when the window widens again: it does not come back on its
    // own over the text it was just closing for.
    await page.setViewportSize({ width: 1440, height: 900 });
    await expect(motion).not.toHaveClass(/is-open/);

    // And it can be opened by hand, now that there is room for it.
    const toggle = page.getByTestId("workspace-panel-controls").getByRole("button", { name: "环境信息与进度" });
    await expect(toggle).not.toHaveAttribute("aria-disabled", "true");
    await toggle.click();
    await expect(motion).toHaveClass(/is-open/);
  });

  test("the composer's controls do not share a line they cannot both fit on", async ({ page }) => {
    await page.setViewportSize({ width: 480, height: 900 });
    await configureFixture(page, () => undefined);
    await openApp(page, "#session=A");

    // The permission control is a fixed, unshrinkable label, and it is the
    // reason a single-row toolbar eventually pushes the send control off the
    // row. Below the stacking threshold it keeps its glyph and drops its
    // words.
    const permission = page.getByTestId("composer-permission-mode");
    const cluster = page.locator(".webui-composer-toolbar-actions");
    await expect(permission).toBeVisible();
    await expect(cluster).toBeVisible();

    const permissionBox = await permission.boundingBox();
    const clusterBox = await cluster.boundingBox();
    const sharesALine = permissionBox.y < clusterBox.y + clusterBox.height
      && clusterBox.y < permissionBox.y + permissionBox.height;
    if (sharesALine) {
      // On the same line they must not overlap.
      expect(permissionBox.x + permissionBox.width).toBeLessThanOrEqual(clusterBox.x + 1);
    }
    expect(await horizontalOverflow(page)).toBeLessThanOrEqual(1);
  });
});
