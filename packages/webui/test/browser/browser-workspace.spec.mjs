// The browser's half of the workspace panel.
//
// The strip's web tabs, the toolbar and the page are all driven by what the
// runtime publishes, and the runtime is the only thing that can publish them.
// The fixture now answers the browser family with a synthetic browser -- pages
// it paints itself, tabs a test stages, and a run's selection it marks -- so
// this spec can drive the panel's browser half end to end: the launcher's
// address box opens a page, the panel is a window around it, the Agent's page
// is named where a browser has no such mark, and a gesture lands on the page
// in front rather than on the Agent's.
//
// What this spec does NOT prove is the runtime's own browser behaviour. The
// isolated Chromium, the extension and the bridge are proven elsewhere -- by
// the runtime's integration tests and by `browser-bridge-real-*.spec.ts`.
// What is proven here is the client's half: that the panel draws a window,
// that the strip and the toolbar follow what the runtime published, and that
// the two cells stay apart.

import { expect } from "@playwright/test";

import { configureFixture, openApp, test } from "./harness.mjs";

const openPanel = async (page) => {
  const browserButton = page
    .getByTestId("workspace-panel-controls")
    .getByRole("button", { name: "浏览器" });
  await browserButton.click();
  await expect(page.getByTestId("workspace-panel")).toBeVisible();
  // The panel's browser half shows the pages the runtime published, and the
  // launcher is the empty case: the control opens a page when the runtime has
  // published one. So the launcher is not what opening the panel guarantees —
  // `openLauncher` below is what asks for it.
};

/** The launcher's address box, opened the way a person opens it. */
const openLauncher = async (page) => {
  if (!(await page.getByTestId("workspace-launcher").isVisible().catch(() => false))) {
    await page.getByTestId("workspace-add-tab").click();
  }
  await expect(page.getByTestId("workspace-launcher")).toBeVisible();
};

const openPage = async (page, url) => {
  await openLauncher(page);
  await page.getByTestId("workspace-launcher-url").fill(url);
  await page.getByTestId("workspace-launcher-url-submit").click();
};

test("the browser control shows its browser glyph and opens a new tab page by default", async ({ page }) => {
  await configureFixture(page, () => undefined);
  await openApp(page);

  const browserButton = page.getByTestId("workspace-panel-controls").getByRole("button", { name: "浏览器" });
  await expect(browserButton).toHaveAttribute("title", "浏览器");
  // The control's glyph is the tabler browser icon. It used to be a globe
  // drawn as an SVG circle, and the library draws this one as paths, so the
  // assertion names the icon rather than the shape it happens to be made of.
  await expect(browserButton.locator("svg.tabler-icon-browser")).toHaveCount(1);
  await browserButton.click();

  await expect(page.getByTestId("workspace-panel")).toHaveAttribute("data-active-tab", "launcher");
  await expect(page.getByTestId("workspace-launcher")).toBeVisible();
});

test("pointer and wheel input start immediately and coalesce within a display frame", async ({ page }) => {
  await configureFixture(page, () => undefined);
  await openApp(page);
  await openPanel(page);
  await openPage(page, "https://example.test/");
  const frame = page.getByTestId("browser-panel-frame");
  await expect(frame).toBeVisible();
  await page.clock.install();
  await page.clock.pauseAt(new Date());
  // With timers paused, the first input must reach the wire without a timeout firing.
  await frame.dispatchEvent("pointermove", { clientX: 100, clientY: 100 });
  const cancelled = await frame.evaluate((image) => !image.dispatchEvent(new WheelEvent("wheel", {
    bubbles: true, cancelable: true, clientX: 100, clientY: 100, deltaY: 10, deltaX: 0,
  })));
  expect(cancelled).toBe(true);
  const inputs = () => page.evaluate(() => window.__fixture.requests
    .filter((request) => request.operation === "sendBrowserInput")
    .map((request) => request.body));
  expect((await inputs()).map((body) => body.action)).toEqual(["move", "scroll"]);
  await frame.dispatchEvent("wheel", { clientX: 100, clientY: 100, deltaY: 20, deltaX: 0 });
  await frame.dispatchEvent("wheel", { clientX: 100, clientY: 100, deltaY: 30, deltaX: 0 });
  expect(await inputs()).toHaveLength(2);
  await page.clock.runFor(17);
  const delivered = await inputs();
  expect(delivered).toHaveLength(3);
  expect(delivered[2]).toMatchObject({ action: "scroll", deltaY: 50 });
});

test("the launcher's address box opens a page, and the panel is a window around it", async ({ page }) => {
  await configureFixture(page, () => undefined);
  await openApp(page);
  await openPanel(page);

  await openPage(page, "https://example.test/");

  // The runtime was asked, and it answered with a page.
  await expect
    .poll(() => page.evaluate(() => window.__fixture.browserTabs().length))
    .toBe(1);
  await expect
    .poll(() => page.evaluate(() => window.__fixture.requests.some((request) => request.operation === "openBrowserWebTab")))
    .toBe(true);

  // The window: a toolbar with the url in an address bar, and the page.
  await expect(page.getByTestId("browser-toolbar")).toBeVisible();
  await expect(page.getByTestId("browser-toolbar-url")).toHaveText("https://example.test/");
  await expect(page.getByTestId("browser-panel-frame")).toBeVisible();

  // A window has no heading above its page, and no list of the browser's pages
  // beside it: the strip is where the tabs are. The section keeps its name for
  // anyone who cannot see the window.
  await expect(page.locator(".webui-browser-panel-title")).toHaveCount(0);
  await expect(page.locator(".webui-browser-targets")).toHaveCount(0);
  await expect(page.getByTestId("browser-panel")).toHaveAttribute("aria-label", "浏览器");
});

test("the browser page fills the workspace body and the workspace edge resizes horizontally", async ({ page }) => {
  await configureFixture(page, () => undefined);
  await openApp(page);
  await openPanel(page);
  await openLauncher(page);

  const brand = page.getByTestId("workspace-launcher-brand");
  const omnibox = page.locator(".webui-workspace-launcher-omnibox");
  const launcher = page.getByTestId("workspace-launcher");
  const tiles = page.locator(".webui-workspace-launcher-tiles");
  await expect(brand).toBeVisible();
  const brandBox = await brand.boundingBox();
  const omniboxBox = await omnibox.boundingBox();
  const launcherBox = await launcher.boundingBox();
  const tilesBox = await tiles.boundingBox();
  expect(Math.abs(brandBox.x + brandBox.width / 2 - (omniboxBox.x + omniboxBox.width / 2))).toBeLessThanOrEqual(1);
  expect(brandBox.y + brandBox.height).toBeLessThan(omniboxBox.y);
  expect((brandBox.y + tilesBox.y + tilesBox.height) / 2).toBeLessThan(launcherBox.y + launcherBox.height / 2);
  await expect(brand).toHaveAttribute("aria-label", "MiniMax");
  await expect(brand.locator(".webui-workspace-launcher-wordmark")).toHaveText("MiniMax");
  expect(brandBox.width).toBeGreaterThan(0);
  expect(brandBox.height).toBeGreaterThan(0);
  await page.getByTestId("workspace-launcher-url").fill("https://example.test/");
  await page.getByTestId("workspace-launcher-url-submit").click();
  // The panel swaps the launcher for the page, and the swap re-mounts the
  // panel: a gesture started before it finished is lost with the old tree.
  await expect(page.getByTestId("browser-toolbar")).toBeVisible();

  const stage = page.locator(".webui-browser-stage");
  const frame = page.getByTestId("browser-panel-frame");
  const stageBox = await stage.boundingBox();
  const frameBox = await frame.boundingBox();
  expect(stageBox).not.toBeNull();
  expect(frameBox).not.toBeNull();
  expect(Math.abs(frameBox.width - stageBox.width)).toBeLessThanOrEqual(1);
  expect(Math.abs(frameBox.height - stageBox.height)).toBeLessThanOrEqual(1);

  const panel = page.getByTestId("workspace-panel");
  const before = await panel.boundingBox();
  const handle = page.getByRole("separator", { name: "调整工作区面板宽度" });
  await page.mouse.move(before.x + 4, before.y + before.height / 2);
  await page.mouse.down();
  await page.mouse.move(before.x - 56, before.y + before.height / 2);
  await page.mouse.up();
  // The panel's width is a controlled style, so the drag lands in state and
  // the layout follows when React flushes it — the box is polled rather than
  // read once, the same way the keyboard nudge below is waited for.
  await expect
    .poll(async () => (await panel.boundingBox()).width)
    .toBeGreaterThan(before.width + 40);
  const after = await panel.boundingBox();
  await expect(handle).toBeVisible();
  await handle.focus();
  await page.keyboard.press("ArrowLeft");
  await expect.poll(async () => (await panel.boundingBox()).width).toBeGreaterThan(after.width + 10);
});

test("a narrow workspace crops the page instead of stretching its aspect ratio", async ({ page }) => {
  await page.setViewportSize({ width: 760, height: 900 });
  await configureFixture(page, () => undefined);
  await openApp(page);
  await openPanel(page);
  await openPage(page, "https://example.test/");

  const frame = page.getByTestId("browser-panel-frame");
  await expect(frame).toBeVisible();
  await expect.poll(() => frame.evaluate((image) => image.naturalWidth)).toBe(640);
  await expect.poll(() => frame.evaluate((image) => image.naturalHeight)).toBe(400);
  await expect(frame).toHaveCSS("object-fit", "cover");
  await expect(frame).toHaveCSS("object-position", "0% 0%");
});

test("mouse clicks in the cropped part of a narrow browser page map to the visible page coordinates", async ({ page }) => {
  await page.setViewportSize({ width: 760, height: 900 });
  await configureFixture(page, () => undefined);
  await openApp(page);
  await openPanel(page);
  await openPage(page, "https://example.test/");

  const frame = page.getByTestId("browser-panel-frame");
  await expect(frame).toBeVisible();
  await expect.poll(() => frame.evaluate((image) => image.naturalWidth)).toBe(640);

  const box = await frame.boundingBox();
  const clickX = box.x + box.width * 0.25;
  const clickY = box.y + box.height * 0.25;
  const scale = Math.max(box.width / 640, box.height / 400);
  const drawnWidth = 640 * scale;
  const drawnHeight = 400 * scale;
  const insetX = 0;
  const insetY = 0;
  const expectedX = (clickX - box.x - insetX) * 640 / drawnWidth;
  const expectedY = (clickY - box.y - insetY) * 400 / drawnHeight;
  await page.mouse.click(clickX, clickY);
  await expect.poll(() => page.evaluate(() => window.__fixture.requests
    .filter((request) => request.operation === "sendBrowserInput")
    .filter((request) => request.body.kind === "pointer" && ["press", "release"].includes(request.body.action))
    .map((request) => request.body.action))).toEqual(["press", "release"]);

  const points = await page.evaluate(() => window.__fixture.requests
    .filter((request) => request.operation === "sendBrowserInput")
    .filter((request) => request.body.kind === "pointer" && request.body.action === "press")
    .map((request) => request.body));
  expect(points).toHaveLength(1);
  expect(points[0].target.targetId).toBe("tab-1");
  expect(Math.abs(points[0].x - expectedX)).toBeLessThanOrEqual(1);
  expect(Math.abs(points[0].y - expectedY)).toBeLessThanOrEqual(1);
});

test("the strip shows the page the runtime published, and the panel follows it", async ({ page }) => {
  await configureFixture(page, () => {
    window.__fixture.setBrowserTabs([
      { id: "tab-1", title: "Example Domain", url: "https://example.test/" },
      { id: "tab-2", title: "Another Page", url: "https://another.test/" },
    ]);
  });
  await openApp(page);
  await openPanel(page);

  // Two pages, two rows in the strip. The rows are the workspace's own tabs,
  // so they are found by the page's title -- which is what a person reads.
  await expect(page.getByRole("tab", { name: "Example Domain" })).toBeVisible();
  await expect(page.getByRole("tab", { name: "Another Page" })).toBeVisible();

  // Choosing one brings its page to the front, and the address bar names it.
  await page.getByRole("tab", { name: "Another Page" }).click();
  await expect(page.getByTestId("browser-toolbar-url")).toHaveText("https://another.test/");
  await expect(page.getByTestId("browser-panel-frame")).toBeVisible();
});

test("the page the Agent is on is named at the quiet end of the toolbar", async ({ page }) => {
  await configureFixture(page, () => {
    window.__fixture.setBrowserTabs([
      { id: "tab-1", title: "Person page", url: "https://person.test/" },
      { id: "tab-2", title: "Agent page", url: "https://agent.test/", selected: true },
    ]);
  });
  await openApp(page);
  await openPanel(page);

  // The mark says whose page it is, and which page.
  const mark = page.getByTestId("browser-toolbar-agent");
  await expect(mark).toBeVisible();
  await expect(mark).toContainText("Agent");
  await expect(mark).toContainText("Agent page");

  // It is a report and not a control: nothing in the panel writes the Agent's
  // selection.
  await expect(page.getByTestId("browser-panel")).not.toContainText("webui-browser-target");
  const wrote = await page.evaluate(() =>
    window.__fixture.requests.some((request) => request.operation === "selectBrowserTarget"),
  );
  expect(wrote).toBe(false);
});

test("a gesture names the page in front, not the page the Agent is on", async ({ page }) => {
  await configureFixture(page, () => {
    window.__fixture.setBrowserTabs([
      { id: "tab-1", title: "Person page", url: "https://person.test/" },
      { id: "tab-2", title: "Agent page", url: "https://agent.test/", selected: true },
    ]);
  });
  await openApp(page);
  await openPanel(page);
  await page.getByRole("tab", { name: "Person page" }).click();
  await expect(page.getByTestId("browser-toolbar-url")).toHaveText("https://person.test/");

  await page.getByTestId("browser-panel-frame").click();

  await expect
    .poll(() =>
      page.evaluate(() => {
        const sent = window.__fixture.requests.filter((request) => request.operation === "sendBrowserInput");
        return sent.length > 0 ? sent[sent.length - 1].body : null;
      }),
    )
    .not.toBeNull();
  await expect
    .poll(() =>
      page.evaluate(() =>
        window.__fixture.requests
          .filter((request) => request.operation === "sendBrowserInput")
          .map((request) => request.body)
          .filter((body) => body.kind === "pointer" && ["press", "release"].includes(body.action))
          .map((body) => body.action),
      ),
    )
    .toEqual(["press", "release"]);
  const sent = await page.evaluate(() => {
    const all = window.__fixture.requests.filter((request) => request.operation === "sendBrowserInput");
    return all[all.length - 1].body;
  });
  expect(sent.target.targetId).toBe("tab-1");
  expect(sent.target.targetId).not.toBe("tab-2");
  // The Agent's page was never named, and nothing wrote its selection.
  const wrote = await page.evaluate(() =>
    window.__fixture.requests.some((request) => request.operation === "selectBrowserTarget"),
  );
  expect(wrote).toBe(false);
});

test("a surface that is switched off refuses the page, and says so", async ({ page }) => {
  await configureFixture(page, () => {
    window.__fixture.setBrowserAuthorization({ isolatedChromium: false });
  });
  await openApp(page);
  await openPanel(page);

  await openPage(page, "https://example.test/");

  // The runtime refused, and the launcher says what happened instead of
  // opening a page that will never exist.
  await expect(page.getByTestId("workspace-launcher-error")).toBeVisible();
  const opened = await page.evaluate(() =>
    window.__fixture.browserTabs().length,
  );
  expect(opened).toBe(0);
});
