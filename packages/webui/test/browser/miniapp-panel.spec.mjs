// The Mini App surfaces in the built client: launcher tile → picker → view.
//
// This is the acceptance the unit tests cannot give. They prove the reducer and
// the projection; this drives the assembled client — the real panel, the real
// launcher, the real published picker and view — against the suite's fixture
// transport, and asserts what a person sees: the tile opens a list, the row they
// choose starts the Mini App, and the panel frames the view URL the open
// operation answered with.
//
// The fixture stands in for the host, so what this does *not* prove is the
// runtime's own start path, the proxy, or that a real Mini App's page renders
// inside the frame. Those are `miniapp-operations.test.ts`,
// `miniapp-surfaces.test.tsx` and the runtime's own suites.
//
// The composer case reaches further than the rest: the framed document is served
// by the spec at a second loopback origin, so the view's own `message` listener,
// its sender check and its composer write all run for real. What is not real is
// the page *half* of the bridge — the proxy injects that script in production and
// the harness serves no proxy — so the spec posts the same wire message the
// injected bridge posts, from inside the frame.

import { expect } from "@playwright/test";

import { configureFixture, openApp, openLauncherTile, test } from "./harness.mjs";

for (const theme of ["light", "dark"]) {
  test(`the full-access launcher loads local application icons in ${theme} theme`, async ({ page }) => {
    await page.addInitScript((value) => localStorage.setItem("webui-theme", value), theme);
    await configureFixture(page, () => {
      window.__WEBUI_CONFIG__.token = "";
      window.__fixture.setResponse("listMiniApps", { miniApps: [{
        pluginId: "demo.miniapp", displayName: "图标测试应用",
        iconUrl: "/mavis/api/file/preview?path=%2Fplugins%2Fdemo%2Ficon.svg",
        runtime: { kind: "process", status: "stopped" },
      }] });
    });
    await page.route("**/workspace-file?*", (route) => route.fulfill({
      status: 200, contentType: "image/svg+xml",
      body: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect width="100" height="100" rx="24" fill="#168a62"/><circle cx="50" cy="50" r="24" fill="white"/></svg>',
    }));
    await openApp(page, "");
    await page.getByRole("button", { name: "应用", exact: true }).click();
    const icon = page.getByTestId("miniapp-launcher-icon-demo.miniapp");
    await expect(icon).toBeVisible();
    await expect(icon).toHaveAttribute("src", "/workspace-file?dir=%2Fplugins%2Fdemo&path=icon.svg");
    await expect.poll(() => icon.evaluate((image) => image.complete && image.naturalWidth > 0)).toBe(true);
    await page.screenshot({ path: test.info().outputPath(`full-access-icons-${theme}.png`) });
  });
}

test("the rail launcher refreshes on return and while open without reloading", async ({ page }) => {
  await configureFixture(page, () => {
    window.__fixture.setResponse("listMiniApps", { miniApps: [{
      pluginId: "demo.miniapp", displayName: "演示应用",
      runtime: { kind: "process", status: "stopped" },
    }] });
  });
  await openApp(page);
  await page.getByRole("button", { name: "应用", exact: true }).click();
  const card = page.getByTestId("miniapp-launcher-card-demo.miniapp");
  await expect(card).toHaveAttribute("data-status", "stopped");
  await page.evaluate(() => {
    window.__fixture.setResponse("listMiniApps", { miniApps: [{
      pluginId: "demo.miniapp", displayName: "演示应用",
      runtime: { kind: "process", status: "running" },
    }] });
    window.dispatchEvent(new Event("focus"));
  });
  await expect(card).toHaveAttribute("data-status", "running", { timeout: 1_000 });
  await page.screenshot({ path: test.info().outputPath("launcher-running.png") });
  await page.evaluate(() => window.__fixture.setResponse("listMiniApps", { miniApps: [{
    pluginId: "demo.miniapp", displayName: "演示应用",
    runtime: { kind: "process", status: "stopped" },
  }] }));
  await expect(card).toHaveAttribute("data-status", "stopped");
});

test("the rail close control reports pending and a refused stop", async ({ page }) => {
  await page.addInitScript(() => window.localStorage.setItem("webui-theme", "dark"));
  await configureFixture(page, () => {
    window.__fixture.setResponse("listMiniApps", { miniApps: [{
      pluginId: "demo.miniapp", displayName: "演示应用",
      runtime: { kind: "process", status: "running" },
    }] });
    window.__fixture.delayNext("stopMiniApp", {});
  });
  await openApp(page);
  await page.getByRole("button", { name: "应用", exact: true }).click();
  const card = page.getByTestId("miniapp-launcher-card-demo.miniapp");
  await card.hover();
  const stop = card.getByRole("button", { name: "关闭演示应用", exact: true });
  await stop.click();
  await expect(stop).toHaveAttribute("aria-busy", "true");
  await expect(page.getByRole("dialog", { name: "正在处理…" })).toBeVisible();
  await expect(page.getByRole("dialog", { name: "正在处理…" })).toBeInViewport();
  await expect(page.getByRole("dialog", { name: "正在处理…" })).toHaveCSS("opacity", "1");
  const layers = await page.evaluate(() => ({
    feedback: Number(getComputedStyle(document.querySelector(".webui-feedback-loading-overlay")).zIndex),
    launcher: Number(getComputedStyle(document.querySelector('[data-testid="miniapp-launcher"]')).zIndex),
  }));
  expect(layers.feedback).toBeGreaterThan(layers.launcher);
  await page.screenshot({ path: test.info().outputPath("launcher-stopping-dark.png") });
  await page.evaluate(() => window.__fixture.resolveAllPending("stopMiniApp", {}, { success: true }));
  await expect(stop).not.toHaveAttribute("aria-busy", "true");
  await page.evaluate(() => window.__fixture.refuseOperation("stopMiniApp", "harness_error", "synthetic stop refused"));
  await stop.click();
  await expect(page.getByTestId("miniapp-picker-refusal-demo.miniapp")).toContainText("synthetic stop refused");
  await expect(card).toHaveAttribute("data-status", "running");
});

test("the launcher uses shared animated skeleton cards while the app list loads", async ({ page }) => {
  await configureFixture(page, () => {
    window.__WEBUI_FIXTURE_SETUP__ ??= [];
    window.__WEBUI_FIXTURE_SETUP__.push(() => {
      window.__fixture.delayEvery("listMiniApps", {});
      window.__fixture.setResponse("listMiniApps", { miniApps: [{
        pluginId: "demo.miniapp",
        displayName: "演示应用",
        runtime: { kind: "process", status: "stopped" },
      }] });
      window.__fixture.setResponse("openMiniApp", {
        pluginId: "demo.miniapp",
        viewUrl: `${window.location.origin}/__miniapp-stub`,
      });
    });
  });
  await page.route("**/__miniapp-stub", (route) => route.fulfill({
    status: 200,
    contentType: "text/html; charset=utf-8",
    body: "<!doctype html><html><body><p>Mini App stub</p></body></html>",
  }));
  await openApp(page);
  await page.getByRole("button", { name: "应用" }).click();

  const launcher = page.getByTestId("miniapp-launcher");
  const skeletons = launcher.getByTestId("miniapp-launcher-loading-skeleton");
  await expect.poll(() => page.evaluate(() => window.__fixture.pending.filter((request) => request.operation === "listMiniApps").length)).toBeGreaterThan(0);
  const loadingStatus = launcher.getByTestId("miniapp-launcher-loading-status");
  await expect(loadingStatus).toHaveClass(/webui-feedback-sr/u);
  await expect(loadingStatus).toHaveCSS("clip-path", "inset(50%)");
  await expect(skeletons).toHaveCount(6);
  await expect(skeletons.first()).toHaveClass(/webui-motion-loading/u);
  await expect(skeletons.first()).toHaveCSS("animation-name", "webui-skeleton-pulse");

  await page.evaluate(() => window.__fixture.resolveAllPending("listMiniApps", {}, { miniApps: [{
    pluginId: "demo.miniapp",
    displayName: "演示应用",
    runtime: { kind: "process", status: "stopped" },
  }] }));
  await expect(launcher.getByTestId("miniapp-launcher-card-demo.miniapp")).toBeVisible();
  await expect(skeletons).toHaveCount(0);
});

test("the left rail 应用 entry opens a frosted task-card panel with loaded icons", async ({ page }) => {
  await page.route("**/workspace-file?*", (route) => route.fulfill({
    status: 200,
    contentType: "image/svg+xml",
    body: "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 40 40\"><rect width=\"40\" height=\"40\" fill=\"red\"/></svg>",
  }));
  await configureFixture(page, () => {
    window.__WEBUI_FIXTURE_SETUP__ ??= [];
    window.__WEBUI_FIXTURE_SETUP__.push(() => {
      window.__fixture.setResponse("listMiniApps", { miniApps: [
        {
          pluginId: "demo.miniapp",
          displayName: "演示应用",
          description: "可启动的应用",
          iconUrl: "/mavis/api/file/preview?path=%2Fplugins%2Fdemo%2Ficon.svg",
          runtime: { kind: "process", status: "stopped" },
        },
        {
          pluginId: "disabled.miniapp",
          displayName: "停用应用",
          description: "仍然属于已安装列表",
          enabled: false,
          runtime: { kind: "process", status: "stopped" },
        },
      ] });
    });
  });
  await openApp(page);

  const appEntry = page.getByRole("button", { name: "应用", exact: true });
  const appGlyph = appEntry.locator("svg");
  const pluginsGlyph = page.getByRole("button", { name: "插件", exact: true }).locator("svg");
  await expect(appGlyph).toHaveAttribute("width", "18");
  await expect(appGlyph).toHaveAttribute("height", "18");
  await expect(appGlyph).toHaveAttribute("stroke-width", "1.7");
  await expect(appGlyph).toHaveAttribute("width", await pluginsGlyph.getAttribute("width"));
  await expect(appGlyph).toHaveAttribute("stroke-width", await pluginsGlyph.getAttribute("stroke-width"));
  await appEntry.click();

  const launcher = page.getByTestId("miniapp-launcher");
  await expect(launcher).toBeVisible();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(launcher).toHaveAttribute("aria-label", "应用");
  await expect(launcher).toHaveAttribute("data-webui-page", "panel");
  await expect(launcher).toHaveAttribute("data-webui-motion", "surface");
  await expect(launcher).toHaveCSS("backdrop-filter", /blur/u);
  const blurAmount = await launcher.evaluate((element) => Number(element.ownerDocument.defaultView.getComputedStyle(element).backdropFilter.match(/blur\(([\d.]+)px\)/u)?.[1]));
  expect(blurAmount).toBeGreaterThan(30);
  const panelBox = await launcher.boundingBox();
  const triggerBox = await page.getByRole("button", { name: "应用", exact: true }).boundingBox();
  expect(panelBox).not.toBeNull();
  expect(triggerBox).not.toBeNull();
  expect(panelBox.width).toBeLessThanOrEqual(701);
  expect(panelBox.x).toBeGreaterThan(triggerBox.x);
  expect(panelBox.x + panelBox.width).toBeLessThanOrEqual(1440);
  await expect(launcher.getByTestId("miniapp-launcher-card-demo.miniapp")).toBeVisible();
  await expect(launcher.getByTestId("miniapp-launcher-card-disabled.miniapp")).toBeVisible();
  await expect(launcher).toContainText("演示应用");
  await expect(launcher).toContainText("停用应用");
  await expect(launcher.locator(".webui-miniapp-launcher-icon")).toHaveCount(0);
  const icon = launcher.getByTestId("miniapp-launcher-icon-demo.miniapp");
  const grid = launcher.locator(".webui-miniapp-launcher-grid");
  await expect(grid).toHaveCSS("display", "grid");
  const columns = await grid.evaluate((element) => element.ownerDocument.defaultView.getComputedStyle(element).gridTemplateColumns.trim().split(/\s+/u));
  expect(columns).toHaveLength(3);
  await expect(icon).toHaveAttribute("src", /\/workspace-file\?token=synthetic-token&dir=%2Fplugins%2Fdemo&path=icon\.svg/u);
  await expect.poll(() => icon.evaluate((image) => image.complete && image.naturalWidth > 0)).toBe(true);
  const preview = launcher.getByTestId("miniapp-launcher-preview-demo.miniapp");
  await expect(preview).toBeVisible();
  await expect(preview).toHaveCSS("overflow", "visible");
  await expect(preview.locator(".webui-miniapp-launcher-preview-motion")).toHaveCSS("overflow", "visible");
  const card = launcher.getByTestId("miniapp-launcher-card-demo.miniapp");
  const cardBox = await card.boundingBox();
  const previewBox = await preview.boundingBox();
  expect(cardBox).not.toBeNull();
  expect(previewBox).not.toBeNull();
  expect(Math.abs(previewBox.width - previewBox.height)).toBeLessThan(1.5);
  expect(cardBox.width / Number.parseFloat(columns[0])).toBeGreaterThan(0.77);
  expect(cardBox.width / Number.parseFloat(columns[0])).toBeLessThan(0.83);
  await expect(preview).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
  const iconSize = await icon.evaluate((image) => ({
    width: Number.parseFloat(image.ownerDocument.defaultView.getComputedStyle(image).width),
    height: Number.parseFloat(image.ownerDocument.defaultView.getComputedStyle(image).height),
  }));
  expect(Math.abs(iconSize.width - previewBox.width)).toBeLessThan(8);
  expect(Math.abs(iconSize.height - previewBox.height)).toBeLessThan(8);
  await expect(icon).toHaveCSS("opacity", "1");
  await expect(icon).toHaveCSS("filter", "none");
  await expect(icon).toHaveCSS("object-fit", "cover");
  const iconWidthBeforeHover = (await icon.boundingBox()).width;
  await icon.hover();
  await expect.poll(() => icon.evaluate((image) => image.getBoundingClientRect().width)).toBeGreaterThan(iconWidthBeforeHover * 1.05);
  expect(previewBox.width).toBeGreaterThan(105);
  expect(previewBox.width).toBeLessThan(130);
  await launcher.getByRole("button", { name: "关闭应用面板" }).click();
  await expect(launcher).toHaveAttribute("data-webui-motion-state", "exit");
  await expect(launcher).toHaveCSS("animation-name", "webui-motion-surface-exit");
  await expect(launcher).toHaveCount(0);
});

test("a stopped app card opens its standalone tab directly", async ({ page }) => {
  await configureFixture(page, () => {
    window.__WEBUI_FIXTURE_SETUP__ ??= [];
    window.__WEBUI_FIXTURE_SETUP__.push(() => {
      window.__fixture.setResponse("listMiniApps", { miniApps: [{
        pluginId: "demo.miniapp",
        displayName: "演示应用",
        runtime: { kind: "process", status: "stopped" },
      }] });
    });
  });
  await openApp(page);
  await page.getByRole("button", { name: "应用" }).click();
  const launcher = page.getByTestId("miniapp-launcher");
  await expect(launcher.getByTestId("miniapp-launcher-card-demo.miniapp")).toBeVisible();

  const popupPromise = page.waitForEvent("popup");
  await launcher.getByRole("button", { name: "打开演示应用" }).click();
  const popup = await popupPromise;
  await expect(popup).toHaveURL(/\/miniapp\?token=synthetic-token&plugin=demo\.miniapp&session=A/u);
  await expect(popup.getByTestId("miniapp-standalone")).toBeVisible();
  await expect(popup.getByTestId("miniapp-view-frame")).toBeVisible();
  const standaloneGeometry = await popup.evaluate(() => {
    const view = document.querySelector('[data-testid="miniapp-view"]');
    const frame = document.querySelector('[data-testid="miniapp-view-frame"]');
    const move = document.querySelector(".webui-miniapp-view-move");
    return { viewport: innerHeight, view: view.getBoundingClientRect().height, frame: frame.getBoundingClientRect().height, move: move.getBoundingClientRect().height };
  });
  expect(standaloneGeometry.frame).toBeGreaterThan(standaloneGeometry.viewport - standaloneGeometry.move - 48);
});

test("a running app card cannot reopen and only exposes stop on hover", async ({ page }) => {
  await configureFixture(page, () => {
    window.__WEBUI_FIXTURE_SETUP__ ??= [];
    window.__WEBUI_FIXTURE_SETUP__.push(() => {
      window.__fixture.setResponse("listMiniApps", { miniApps: [{
        pluginId: "running.miniapp",
        displayName: "运行中的应用",
        runtime: { kind: "process", status: "running" },
      }] });
    });
  });
  await openApp(page);
  await page.getByRole("button", { name: "应用" }).click();
  const launcher = page.getByTestId("miniapp-launcher");
  const card = launcher.getByTestId("miniapp-launcher-card-running.miniapp");
  const stop = card.getByRole("button", { name: "关闭运行中的应用" });

  await expect(card.getByRole("button", { name: "打开运行中的应用" })).toHaveCount(0);
  await expect(stop).toHaveCSS("opacity", "0");
  await card.hover();
  await expect(stop).toHaveCSS("opacity", "1");
  await stop.click();
  await expect.poll(() => page.evaluate(() => window.__fixture.requests.some((request) => request.operation === "stopMiniApp"))).toBe(true);
});

/** The catalogue row the fixture answers with. */
const MINI_APP = {
  pluginId: "demo.miniapp",
  displayName: "演示应用",
  description: "一个用于浏览器验收的 Mini App",
  runtime: { kind: "process", status: "stopped" },
};

/** Open the workspace panel, the way every other panel spec does. */
async function openWorkspacePanel(page) {
  await page
    .getByTestId("workspace-panel-controls")
    .getByRole("button", { name: "浏览器" })
    .click();
  await expect(page.getByTestId("workspace-panel")).toBeVisible();
}

/**
 * The Mini App's own origin, as the proxy presents it.
 *
 * A second loopback port on purpose: in production the framed page is
 * cross-origin from the client (ADR 0020), and the view's sender check compares
 * this origin with the one the browser reports for the document.
 */
const MINI_APP_ORIGIN = "http://127.0.0.1:49152";
const MINI_APP_VIEW_URL = `${MINI_APP_ORIGIN}/__miniapp-stub`;

/** The page's append request and the host's reply, exactly as the bridge spells them. */
const APPEND_REQUEST = "mcode:miniapp:message-append";
const APPEND_REPLY = "mcode:miniapp:message-append-result";

/**
 * Serves the document the view frames.
 *
 * In production the proxy serves it, injects the credential and injects the
 * page bridge. The harness has no proxy, so the spec answers as one would for
 * the document itself and posts the bridge's wire message itself.
 */
async function serveMiniAppStub(page) {
  await page.route(`${MINI_APP_ORIGIN}/**`, (route) =>
    route.fulfill({
      status: 200,
      contentType: "text/html; charset=utf-8",
      body: "<!doctype html><html><body><button id='drag-handle'>Drag</button></body></html>",
    }),
  );
}

/** The frame document the view loaded, once the browser has it. */
async function loadedMiniAppFrame(page) {
  const handle = await page.getByTestId("miniapp-view-frame").elementHandle();
  await expect
    .poll(async () => (await handle.contentFrame())?.url() ?? "", { timeout: 10_000 })
    .toBe(MINI_APP_VIEW_URL);
  const frame = await handle.contentFrame();
  if (!frame) throw new Error("the Mini App frame is not attached");
  return frame;
}

test("the launcher's 应用 tile turns the tab into the Mini App tool page, and the chosen Mini App is framed", async ({
  page,
}) => {
  await configureFixture(page, () => {
    window.__WEBUI_FIXTURE_SETUP__ ??= [];
    window.__WEBUI_FIXTURE_SETUP__.push(() => {
      window.__fixture.setResponse("listMiniApps", { miniApps: [{
        pluginId: "demo.miniapp",
        displayName: "演示应用",
        description: "一个用于浏览器验收的 Mini App",
        runtime: { kind: "process", status: "stopped" },
      }] });
      window.__fixture.setResponse("openMiniApp", {
        pluginId: "demo.miniapp",
        viewUrl: `${window.location.origin}/__miniapp-stub`,
      });
    });
  });
  await page.setViewportSize({ width: 800, height: 816 });
  await openApp(page);
  await openWorkspacePanel(page);

  // The shortcut is available directly or from 其他 when the panel is narrow.
  await openLauncherTile(page, "miniapp-picker");

  // The tile turns this tab into the tool page, the way every other tile turns
  // it into its view: the new tab page is gone rather than keeping its tiles
  // with a picker underneath them.
  await expect(page.getByTestId("workspace-launcher-tab")).toHaveCount(0);
  await expect(page.getByTestId("workspace-miniapp-picker-tab")).toBeVisible();
  await page.getByRole("button", { name: "展开面板" }).click();

  // The picker is fed by the same listing the catalogue's apps area reads.
  const picker = page.getByTestId("miniapp-picker");
  await expect(picker).toBeVisible();
  await expect(picker).toContainText("演示应用");
  await expect(picker).toContainText("已停止");

  await picker.getByRole("button", { name: "打开" }).click();

  // The start went through the operation, and the panel frames its answer.
  await expect
    .poll(() =>
      page.evaluate(() =>
        window.__fixture.requests.filter((request) => request.operation === "openMiniApp").length,
      ),
    )
    .toBe(1);
  const view = page.getByTestId("miniapp-view");
  await expect(view).toBeVisible();
  await expect(view).toHaveAttribute("data-plugin-id", MINI_APP.pluginId);
  await expect(view).toHaveAttribute("data-state", "open");
  await expect(page.getByTestId("miniapp-view-frame")).toHaveAttribute(
    "src",
    /\/__miniapp-stub$/u,
  );
  const viewGeometry = await page.evaluate(() => {
    const bounds = (selector) => document.querySelector(selector).getBoundingClientRect();
    return {
      body: bounds(".webui-workspace-panel-body").height,
      tab: bounds('[data-testid="workspace-miniapp-tab"]').height,
      view: bounds('[data-testid="miniapp-view"]').height,
      frame: bounds('[data-testid="miniapp-view-frame"]').height,
      panelBottom: bounds(".webui-workspace-panel-body").bottom,
      moveBottom: bounds(".webui-miniapp-view-move").bottom,
      toolbar: bounds(".webui-workspace-file-toolbar--miniapp").toJSON(),
      frameTop: bounds('[data-testid="miniapp-view-frame"]').top,
    };
  });
  expect(viewGeometry.frame).toBeGreaterThan(viewGeometry.body - 48);
  expect(viewGeometry.moveBottom).toBeLessThanOrEqual(viewGeometry.toolbar.bottom);
  expect(viewGeometry.frameTop).toBeGreaterThanOrEqual(viewGeometry.toolbar.bottom);
  // The launcher tab became the Mini App tab; a second tab was not added.
  await expect(page.getByTestId("workspace-panel")).toHaveAttribute("data-active-tab", "miniapp");
});

test("the running Mini App offers its refresh, its stop and the runtime's state, and the refresh reloads the page", async ({
  page,
}) => {
  // The stub is served by the spec, so the count of requests is the count of
  // documents the browser actually fetched: a refresh has to fetch it again.
  let served = 0;
  await page.route("**/__miniapp-stub*", (route) => {
    served += 1;
    return route.fulfill({
      status: 200,
      contentType: "text/html; charset=utf-8",
      body: "<!doctype html><html><body><p>Mini App stub</p></body></html>",
    });
  });
  await configureFixture(page, () => {
    window.__WEBUI_FIXTURE_SETUP__ ??= [];
    window.__WEBUI_FIXTURE_SETUP__.push(() => {
      window.__fixture.setResponse("listMiniApps", {
        miniApps: [
          {
            pluginId: "demo.miniapp",
            displayName: "演示应用",
            description: "一个用于浏览器验收的 Mini App",
            runtime: { kind: "process", status: "stopped" },
          },
        ],
      });
      window.__fixture.setResponse("openMiniApp", {
        pluginId: "demo.miniapp",
        viewUrl: `${window.location.origin}/__miniapp-stub`,
      });
    });
  });
  await page.setViewportSize({ width: 800, height: 816 });
  await openApp(page);
  await openWorkspacePanel(page);
  await openLauncherTile(page, "miniapp-picker");
  await page.getByRole("button", { name: "展开面板" }).click();
  const picker = page.getByTestId("miniapp-picker");
  await expect(picker).toBeVisible();
  await picker.getByRole("button", { name: "打开" }).click();

  const inlineFrame = page.getByTestId("miniapp-view-frame");
  await expect(inlineFrame).toBeVisible();
  await expect.poll(async () => {
    const bounds = await inlineFrame.boundingBox();
    return Boolean(bounds && bounds.width > 0 && bounds.height > 0);
  }).toBe(true);
  await expect.poll(() => served).toBe(1);
  await expect(page.getByTestId("miniapp-stop")).toBeVisible();
  await expect(page.getByTestId("miniapp-refresh")).toBeVisible();

  // The runtime's own state is on screen, not a guess: the catalogue says the
  // Mini App is running, and the badge follows it.
  await page.evaluate(() => {
    window.__fixture.setResponse("listMiniApps", {
      miniApps: [
        {
          pluginId: "demo.miniapp",
          displayName: "演示应用",
          description: "一个用于浏览器验收的 Mini App",
          runtime: { kind: "process", status: "running" },
        },
      ],
    });
  });
  await expect(page.getByTestId("miniapp-view-status")).toHaveText("运行中");

  // The refresh reloads the page the view frames: the same URL is fetched again.
  await page.getByTestId("miniapp-refresh").click();
  await expect.poll(() => served).toBe(2);
  await expect(page.getByTestId("miniapp-view-frame")).toBeVisible();
});

test("a floating Mini App can leave the workspace panel and stay above the main window", async ({ page }) => {
  let served = 0;
  await page.route(`${MINI_APP_ORIGIN}/**`, (route) => {
    served += 1;
    return route.fulfill({
      status: 200,
      contentType: "text/html; charset=utf-8",
      body: "<!doctype html><html style=\"background:#fff\"><body style=\"background:#fff\"><p>Mini App stub</p><button id=\"drag-handle\">drag</button></body></html>",
    });
  });
  await configureFixture(page, () => {
    window.__WEBUI_FIXTURE_SETUP__ ??= [];
    window.__WEBUI_FIXTURE_SETUP__.push(() => {
      window.__fixture.setResponse("listMiniApps", { miniApps: [{
        pluginId: "demo.miniapp",
        displayName: "演示应用",
        description: "一个用于浏览器验收的 Mini App",
        runtime: { kind: "process", status: "running" },
      }] });
      window.__fixture.setResponse("openMiniApp", {
        pluginId: "demo.miniapp",
        viewUrl: "http://127.0.0.1:49152/__miniapp-stub",
      });
    });
  });
  await page.setViewportSize({ width: 1280, height: 900 });
  await openApp(page);
  await openWorkspacePanel(page);
  await openLauncherTile(page, "miniapp-picker");
  await page.getByRole("button", { name: "展开面板" }).click();
  await page.getByTestId("miniapp-picker").getByRole("button", { name: "打开" }).click();

  const frame = await loadedMiniAppFrame(page);
  await frame.evaluate(() => {
    document.body.addEventListener("pointerdown", (event) => {
      if (!(event.target instanceof HTMLButtonElement)) return;
      event.target.setPointerCapture(event.pointerId);
      window.__miniAppDrag = {
        originX: 640,
        originY: 220,
      };
    });
    document.body.addEventListener("pointermove", (event) => {
      const drag = window.__miniAppDrag;
      if (!drag) return;
      drag.originX += event.movementX;
      drag.originY += event.movementY;
      window.parent.postMessage({
        type: "webui.miniapp.window.request",
        requestId: `drag-${event.timeStamp}`,
        method: "update",
        patch: {
          mode: "window",
          x: drag.originX,
          y: drag.originY,
          width: 320,
          height: 360,
        },
      }, "*");
    });
  });
  await frame.evaluate(() => window.parent.postMessage({
    type: "webui.miniapp.window.request",
    requestId: "put-on-desktop",
    method: "update",
    patch: { mode: "window", x: 640, y: 220, width: 320, height: 360 },
  }, "*"));

  const panel = page.getByTestId("workspace-panel");
  const windowFrame = page.getByTestId("miniapp-view-frame");
  await expect.poll(async () => (await windowFrame.boundingBox())?.x ?? -1).toBe(640);
  await expect.poll(() => windowFrame.evaluate((element) => getComputedStyle(element).backgroundColor)).toBe("rgba(0, 0, 0, 0)");
  const handle = await frame.locator("#drag-handle").boundingBox();
  expect(handle).not.toBeNull();
  const dragStart = { x: handle.x + 20, y: handle.y + 20 };
  const expectedFloatingX = 640 + 100 - dragStart.x;
  const expectedFloatingY = 220 + 240 - dragStart.y;
  await page.mouse.move(dragStart.x, dragStart.y);
  await page.mouse.down();
  await page.mouse.move(100, 240, { steps: 8 });
  await page.mouse.up();
  await expect.poll(async () => (await windowFrame.boundingBox())?.x ?? -1).toBe(expectedFloatingX);
  const geometry = await page.evaluate(() => {
    const panel = document.querySelector('[data-testid="workspace-panel"]');
    const frame = document.querySelector('[data-testid="miniapp-view-frame"]');
    const rect = frame.getBoundingClientRect();
    const hit = document.elementFromPoint(rect.left + 20, rect.top + 20);
    return {
      frameParent: frame.parentElement?.tagName,
      left: rect.left,
      top: rect.top,
      right: rect.right,
      panelLeft: panel.getBoundingClientRect().left,
      hitFrame: hit === frame,
    };
  });
  expect(geometry.left).toBe(expectedFloatingX);
  expect(geometry.top).toBe(expectedFloatingY);
  expect(geometry.right).toBe(expectedFloatingX + 320);
  expect(geometry.left).toBeLessThan(geometry.panelLeft);
  expect(geometry.frameParent).toBe("BODY");
  expect(geometry.hitFrame).toBe(true);
  expect(served).toBe(1);
  await expect(panel).toBeVisible();
  await frame.evaluate(() => window.parent.postMessage({
    type: "webui.miniapp.window.request",
    requestId: "move-away-from-navigation",
    method: "update",
    patch: { x: 640, y: 220 },
  }, "*"));
  await expect.poll(async () => (await windowFrame.boundingBox())?.x ?? -1).toBe(640);
  await page.getByRole("button", { name: "关闭面板" }).click();
  await expect(panel).toHaveCount(0);
  await expect(windowFrame).toBeVisible();
  const otherSession = page.getByRole("link", { name: /Synthetic session B/ });
  await otherSession.focus();
  await otherSession.press("Enter");
  await expect(windowFrame).toBeVisible();
  await page.getByRole("button", { name: "插件", exact: true }).first().click();
  await expect(windowFrame).toBeVisible();
  expect(served).toBe(1);
});

test("the Mini App picker follows the centered app-list layout in a narrow workspace panel", async ({ page }) => {
  await configureFixture(page, () => {
    window.__WEBUI_FIXTURE_SETUP__ ??= [];
    window.__WEBUI_FIXTURE_SETUP__.push(() => {
      window.__fixture.setResponse("listMiniApps", { miniApps: [{
        pluginId: "demo.miniapp",
        displayName: "演示应用",
        description: "用于演示应用布局的较长说明文字，描述应当可以换行阅读，不应当为了状态和操作按钮而被压缩成一行省略号。",
        runtime: { kind: "process", status: "stopped" },
      }] });
    });
  });
  await page.setViewportSize({ width: 960, height: 850 });
  await openApp(page);
  await openWorkspacePanel(page);
  await openLauncherTile(page, "miniapp-picker");
  await page.getByRole("button", { name: "展开面板" }).click();

  const panel = page.getByTestId("workspace-panel");
  const picker = page.getByTestId("miniapp-picker");
  const row = page.getByTestId("miniapp-picker-row-demo.miniapp");
  await expect(picker).toBeVisible();
  await expect(picker.getByRole("heading", { name: "我的 Mini App" })).toBeVisible();
  await expect(picker.getByRole("button", { name: /管理/u })).toBeVisible();
  await expect(picker.getByRole("button", { name: "创建 Mini App" })).toBeVisible();
  await expect(row.getByRole("button", { name: "打开" })).toContainText("使用");

  const geometry = await page.evaluate(() => {
    const panel = document.querySelector('[data-testid="workspace-panel"]');
    const picker = document.querySelector('[data-testid="miniapp-picker"]');
    const row = document.querySelector('[data-testid="miniapp-picker-row-demo.miniapp"]');
    const copy = row.querySelector(".webui-plugin-copy");
    const status = row.querySelector(".webui-miniapp-picker-status");
    const icon = row.querySelector(".webui-miniapp-picker-icon");
    const actions = row.querySelector(".webui-plugin-actions");
    const description = copy.querySelector("p");
    const bounds = (element) => element.getBoundingClientRect();
    return {
      panel: bounds(panel).toJSON(),
      picker: bounds(picker).toJSON(),
      row: bounds(row).toJSON(),
      copy: bounds(copy).toJSON(),
      status: bounds(status).toJSON(),
      actions: bounds(actions).toJSON(),
      icon: bounds(icon).toJSON(),
      descriptionHeight: bounds(description).height,
    };
  });
  expect(geometry.picker.x).toBeGreaterThan(geometry.panel.x + 12);
  expect(geometry.row.right).toBeLessThanOrEqual(geometry.panel.right - 12);
  expect(geometry.picker.width).toBeLessThanOrEqual(480);
  expect(geometry.icon.height).toBe(48);
  expect(Math.abs(geometry.actions.y + geometry.actions.height / 2 - (geometry.row.y + geometry.row.height / 2))).toBeLessThan(4);
  expect(geometry.status.y).toBeGreaterThan(geometry.copy.y);
  expect(geometry.descriptionHeight).toBeGreaterThan(18);
});

test("the Mini App picker shows its default icon when an app icon fails to load", async ({ page }) => {
  await configureFixture(page, () => {
    window.__WEBUI_FIXTURE_SETUP__ ??= [];
    window.__WEBUI_FIXTURE_SETUP__.push(() => {
      window.__fixture.setResponse("listMiniApps", { miniApps: [{
        pluginId: "demo.miniapp",
        displayName: "演示应用",
        description: "用于验证图标加载失败时的默认图标",
        iconUrl: "/__missing-miniapp-icon.svg",
        runtime: { kind: "process", status: "stopped" },
      }] });
    });
  });
  await page.route("**/__missing-miniapp-icon.svg", (route) =>
    route.fulfill({ status: 404, contentType: "image/svg+xml", body: "" }),
  );
  await openApp(page);
  await openWorkspacePanel(page);
  await openLauncherTile(page, "miniapp-picker");

  const icon = page.getByTestId("miniapp-picker-row-demo.miniapp").locator(".webui-miniapp-picker-icon");
  const failedImage = icon.locator("img");
  const fallback = icon.locator("span svg");
  await expect(failedImage).toBeHidden();
  await expect(fallback).toBeVisible();
});

test("the Mini App management shortcut opens the existing plugin manager", async ({ page }) => {
  await configureFixture(page, () => {
    window.__WEBUI_FIXTURE_SETUP__ ??= [];
    window.__WEBUI_FIXTURE_SETUP__.push(() => {
      window.__fixture.setResponse("listMiniApps", { miniApps: [MINI_APP] });
    });
  });
  await openApp(page);
  await openWorkspacePanel(page);
  await openLauncherTile(page, "miniapp-picker");

  const picker = page.getByTestId("miniapp-picker");
  await picker.getByRole("button", { name: "管理" }).click();
  await expect(page.getByTestId("plugin-management")).toBeVisible();
});

test("an agent presenter request selects its session and displays the Mini App", async ({ page }) => {
  await configureFixture(page, () => {
    window.__WEBUI_FIXTURE_SETUP__ ??= [];
    window.__WEBUI_FIXTURE_SETUP__.push(() => {
      window.__fixture.setResponse("listMiniApps", {
        miniApps: [{
          pluginId: "demo.miniapp",
          displayName: "演示应用",
          runtime: { kind: "process", status: "running" },
        }],
      });
      window.__fixture.setResponse("openMiniApp", {
        pluginId: "demo.miniapp",
        viewUrl: window.location.origin + "/__miniapp-agent-open",
        connection: 3,
      });
      window.__fixture.setResponse("watchMiniAppPresenter", {
        epoch: "service-epoch-1",
        revision: 1,
        action: "open",
        sessionId: "B",
        pluginId: "demo.miniapp",
      });
    });
  });
  await page.route("**/__miniapp-agent-open", (route) =>
    route.fulfill({ status: 200, contentType: "text/html", body: "<p>Agent Mini App</p>" }),
  );
  await openApp(page, "#session=A");

  await expect.poll(() => page.evaluate(() => window.location.hash)).toBe("#session=B");
  await expect(page.getByText("History B synthetic")).toBeVisible();
  await expect(page.getByTestId("workspace-panel")).toBeVisible();
  await expect(page.getByTestId("miniapp-view-frame")).toBeVisible();
  await expect(page.getByTestId("miniapp-view-frame")).toHaveAttribute("src", /__miniapp-agent-open/u);
});

test("a Mini App owned by another client reports the refusal and stays unopened here", async ({ page }) => {
  await configureFixture(page, () => {
    window.__WEBUI_FIXTURE_SETUP__ ??= [];
    window.__WEBUI_FIXTURE_SETUP__.push(() => {
      window.__fixture.setResponse("listMiniApps", { miniApps: [{
        pluginId: "demo.miniapp",
        displayName: "演示应用",
        runtime: { kind: "process", status: "running" },
      }] });
      window.__fixture.refuseOperation(
        "openMiniApp",
        "OWNED_ELSEWHERE",
        "Mini App is already running in Desktop",
      );
    });
  });
  await openApp(page);
  await openWorkspacePanel(page);
  await openLauncherTile(page, "miniapp-picker");
  await page.getByTestId("miniapp-picker").getByRole("button", { name: "打开" }).click();

  await expect(page.getByTestId("miniapp-picker-refusal-demo.miniapp")).toContainText(
    "已在其他客户端运行：Mini App is already running in Desktop",
  );
  await expect(page.getByTestId("miniapp-view-frame")).toHaveCount(0);
  expect(
    await page.evaluate(() =>
      window.__fixture.requests.filter((request) => request.operation === "openMiniApp").length,
    ),
  ).toBe(1);
});

test("a Mini App another client is running can be stopped from here", async ({ page }) => {
  await configureFixture(page, () => {
    window.__WEBUI_FIXTURE_SETUP__ ??= [];
    window.__WEBUI_FIXTURE_SETUP__.push(() => {
      window.__fixture.setResponse("listMiniApps", { miniApps: [{
        pluginId: "demo.shared",
        displayName: "共享应用",
        runtime: {
          kind: "process",
          status: "stopped",
          ownership: "other-client",
          ownerClient: "electron",
        },
      }] });
    });
  });
  await openApp(page);
  await openWorkspacePanel(page);
  await openLauncherTile(page, "miniapp-picker");

  const row = page.getByTestId("miniapp-picker-row-demo.shared");
  await expect(row).toContainText("其他客户端运行中（electron）");
  // The row names the other client and still offers the action that ends the
  // Mini App. The click has to reach the operation, not just draw a button.
  await row.getByRole("button", { name: "停止" }).click();
  await expect.poll(() =>
    page.evaluate(() =>
      window.__fixture.requests.filter(
        (request) => request.operation === "stopMiniApp" && request.body.pluginId === "demo.shared",
      ).length,
    ),
  ).toBe(1);
});

test("a stopped Mini App clears its view and reopens only when the person asks", async ({ page }) => {
  await configureFixture(page, () => {
    window.__WEBUI_FIXTURE_SETUP__ ??= [];
    window.__WEBUI_FIXTURE_SETUP__.push(() => {
      window.__fixture.setResponse("listMiniApps", { miniApps: [{
        pluginId: "demo.miniapp",
        displayName: "演示应用",
        runtime: { kind: "process", status: "stopped" },
      }] });
      window.__fixture.setResponse("openMiniApp", {
        pluginId: "demo.miniapp",
        viewUrl: `${window.location.origin}/__miniapp-stub`,
      });
    });
  });
  await openApp(page);
  await openWorkspacePanel(page);
  await openLauncherTile(page, "miniapp-picker");
  await page.getByTestId("miniapp-picker").getByRole("button", { name: "打开" }).click();
  await expect(page.getByTestId("miniapp-view-frame")).toBeVisible();

  // The runtime stops it while the view is up. The catalogue now says so, and the
  // next reconcile clears the frame and reports the reason.
  await page.evaluate(() => {
    window.__fixture.setResponse("listMiniApps", { miniApps: [{
      pluginId: "demo.miniapp",
      displayName: "演示应用",
      runtime: { kind: "process", status: "stopped" },
    }] });
  });
  await expect
    .poll(() => page.evaluate(() => window.__fixture.requests.filter((request) => request.operation === "listMiniApps").length), {
      timeout: 10_000,
    })
    .toBeGreaterThan(1);
  const stopped = page.getByTestId("miniapp-view-stopped");
  await expect(stopped).toBeVisible();
  await expect(stopped).toContainText("运行已停止");
  await expect(page.getByTestId("miniapp-view-frame")).toHaveCount(0);
  // Nothing restarted it: reopening is the person's button.
  expect(
    await page.evaluate(() =>
      window.__fixture.requests.filter((request) => request.operation === "openMiniApp").length,
    ),
  ).toBe(1);
});

test("a framed Mini App appends to the composer only after the person confirms", async ({ page }) => {
  await serveMiniAppStub(page);
  await configureFixture(page, () => {
    window.__WEBUI_FIXTURE_SETUP__ ??= [];
    window.__WEBUI_FIXTURE_SETUP__.push(() => {
      window.__fixture.setResponse("listMiniApps", { miniApps: [{
        pluginId: "demo.miniapp",
        displayName: "演示应用",
        runtime: { kind: "process", status: "stopped" },
      }] });
      window.__fixture.setResponse("openMiniApp", {
        pluginId: "demo.miniapp",
        viewUrl: "http://127.0.0.1:49152/__miniapp-stub",
      });
    });
  });
  await openApp(page);
  // A draft the person wrote before the page asks for anything.
  const composer = page.getByPlaceholder("输入消息…（输入 / 唤起命令）");
  await composer.fill("我自己的草稿");
  await openWorkspacePanel(page);
  await openLauncherTile(page, "miniapp-picker");
  await page.getByTestId("miniapp-picker").getByRole("button", { name: "打开" }).click();

  const frame = await loadedMiniAppFrame(page);
  await frame.evaluate(() => {
    window.__bridgeReplies = [];
    window.addEventListener("message", (event) => {
      if (event.data && typeof event.data.requestId === "string") window.__bridgeReplies.push(event.data);
    });
  });

  const confirmations = [];
  /** One append from inside the frame, answered by the view's own listener. */
  const ask = async (requestId, text, decision) => {
    page.once("dialog", (dialog) => {
      confirmations.push(dialog.message());
      void (decision === "accept" ? dialog.accept() : dialog.dismiss());
    });
    await frame.evaluate(
      ([requestType, id, body]) =>
        window.parent.postMessage({ type: requestType, requestId: id, text: body }, "*"),
      [APPEND_REQUEST, requestId, text],
    );
    const replyOf = (id) =>
      frame.evaluate(
        (wanted) => window.__bridgeReplies.find((reply) => reply.requestId === wanted) ?? null,
        id,
      );
    await expect.poll(() => replyOf(requestId), { timeout: 10_000 }).not.toBeNull();
    return replyOf(requestId);
  };

  // Accepted: the existing draft is kept and the appended text follows it.
  const accepted = await ask("append-1", "请审阅这个页面", "accept");
  expect(accepted).toEqual({
    type: APPEND_REPLY,
    requestId: "append-1",
    result: { success: true },
  });
  await expect(composer).toHaveValue("我自己的草稿\n请审阅这个页面");
  // The confirmation is the person's, and it names the page that asked.
  expect(confirmations[0]).toContain("演示应用");

  // Declined: the same request, refused, and the draft the person has is intact.
  const declined = await ask("append-2", "不要追加", "decline");
  expect(declined).toEqual({
    type: APPEND_REPLY,
    requestId: "append-2",
    result: { success: false, code: "user_cancelled" },
  });
  await expect(composer).toHaveValue("我自己的草稿\n请审阅这个页面");
  expect(confirmations).toHaveLength(2);

  // An append is a draft and never a send.
  expect(
    await page.evaluate(() => window.__fixture.requests.filter((request) => request.operation === "sendMessage").length),
  ).toBe(0);
});

test("a refused fourth start names the running Mini Apps and frees a slot from the picker", async ({ page }) => {
  await serveMiniAppStub(page);
  await configureFixture(page, () => {
    window.__WEBUI_FIXTURE_SETUP__ ??= [];
    window.__WEBUI_FIXTURE_SETUP__.push(() => {
      window.__fixture.setResponse("listMiniApps", { miniApps: [
        { pluginId: "demo.board", displayName: "看板", runtime: { kind: "process", status: "running" } },
        { pluginId: "demo.notes", displayName: "笔记", runtime: { kind: "process", status: "running" } },
        { pluginId: "demo.canvas", displayName: "画板", runtime: { kind: "process", status: "running" } },
        { pluginId: "demo.fourth", displayName: "待开", runtime: { kind: "process", status: "stopped" } },
      ] });
      // The runtime's own capacity refusal, which the client only reports.
      window.__fixture.refuseOperation("openMiniApp", "BUSY", "Mini App surface action failed");
      window.__fixture.setResponse("openMiniApp", {
        pluginId: "demo.fourth",
        viewUrl: "http://127.0.0.1:49152/__miniapp-stub",
      });
    });
  });
  await openApp(page);
  await openWorkspacePanel(page);
  await openLauncherTile(page, "miniapp-picker");

  const picker = page.getByTestId("miniapp-picker");
  await expect(picker.getByTestId("miniapp-picker-running")).toContainText("看板、笔记、画板");

  await picker.getByTestId("miniapp-picker-row-demo.fourth").getByRole("button", { name: "打开" }).click();
  // The capacity refusal is an event, so it is said through the shared notice
  // host (ADR 0030) rather than drawn inside the picker.
  const capacity = page.locator('[data-webui-toast="true"]').filter({ hasText: "同时最多运行 3 个 Mini App" });
  await expect(capacity).toBeVisible();
  await expect(capacity).toContainText("看板、笔记、画板");
  await expect(capacity).toContainText("请先停止一个再打开");

  // The person frees a slot from the same surface, then retries.
  await page.evaluate(() => {
    window.__fixture.setResponse("listMiniApps", { miniApps: [
      { pluginId: "demo.board", displayName: "看板", runtime: { kind: "process", status: "stopped" } },
      { pluginId: "demo.notes", displayName: "笔记", runtime: { kind: "process", status: "running" } },
      { pluginId: "demo.canvas", displayName: "画板", runtime: { kind: "process", status: "running" } },
      { pluginId: "demo.fourth", displayName: "待开", runtime: { kind: "process", status: "stopped" } },
    ] });
    window.__fixture.allowOperation("openMiniApp");
  });
  await picker.getByTestId("miniapp-picker-row-demo.board").getByRole("button", { name: "停止" }).click();
  await expect.poll(() =>
    page.evaluate(() =>
      window.__fixture.requests.filter((request) => request.operation === "stopMiniApp" && request.body.pluginId === "demo.board").length,
    ),
  ).toBe(1);
  await expect(picker.getByTestId("miniapp-picker-row-demo.board")).toContainText("已停止");

  await picker.getByTestId("miniapp-picker-row-demo.fourth").getByRole("button", { name: "打开" }).click();
  await expect(page.getByTestId("miniapp-picker")).toHaveCount(0);
  await expect(page.getByTestId("workspace-miniapp-tab")).toHaveAttribute("data-plugin-id", "demo.fourth");
  await expect(page.getByTestId("miniapp-view-frame")).toHaveAttribute("src", /\/__miniapp-stub$/);
});

test("a Mini App the runtime already reports as running can be shown in the panel", async ({ page }) => {
  await serveMiniAppStub(page);
  await configureFixture(page, () => {
    window.__WEBUI_FIXTURE_SETUP__ ??= [];
    window.__WEBUI_FIXTURE_SETUP__.push(() => {
      // The row an agent or another surface started: already up when this client
      // reads the catalogue, with nothing presented here yet.
      window.__fixture.setResponse("listMiniApps", { miniApps: [{
        pluginId: "demo.agentstarted",
        displayName: "代理启动",
        description: "由运行时启动的 Mini App",
        runtime: { kind: "process", status: "running" },
      }] });
      window.__fixture.setResponse("openMiniApp", {
        pluginId: "demo.agentstarted",
        viewUrl: "http://127.0.0.1:49152/__miniapp-stub",
      });
    });
  });
  await openApp(page);
  await openWorkspacePanel(page);
  await openLauncherTile(page, "miniapp-picker");

  const picker = page.getByTestId("miniapp-picker");
  const row = picker.getByTestId("miniapp-picker-row-demo.agentstarted");
  await expect(row).toContainText("运行中");
  await expect(picker.getByTestId("miniapp-picker-running")).toContainText("代理启动");
  await expect(row.getByRole("button", { name: "停止" })).toBeEnabled();

  await row.getByRole("button", { name: "打开" }).click();
  await expect(page.getByTestId("workspace-miniapp-tab")).toHaveAttribute(
    "data-plugin-id",
    "demo.agentstarted",
  );
  await expect(page.getByTestId("miniapp-view-frame")).toHaveAttribute("src", /\/__miniapp-stub$/);

  // Showing a running Mini App asks the runtime for its view and nothing else:
  // the surface never stops, restarts or re-implements a start of its own.
  expect(
    await page.evaluate(() =>
      window.__fixture.requests.filter((request) => request.operation === "openMiniApp").length,
    ),
  ).toBe(1);
  expect(
    await page.evaluate(() =>
      window.__fixture.requests.filter((request) => request.operation === "stopMiniApp").length,
    ),
  ).toBe(0);
});

test("the apps area uses installed plugin metadata and has no separate install button", async ({ page }) => {
  await page.route("**/workspace-file?*", (route) => route.fulfill({
    status: 200,
    contentType: "image/svg+xml",
    body: "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 40 40\"><rect width=\"40\" height=\"40\" fill=\"red\"/></svg>",
  }));
  await configureFixture(page, () => {
    window.__WEBUI_FIXTURE_SETUP__ ??= [];
    window.__WEBUI_FIXTURE_SETUP__.push(() => {
      window.__fixture.setResponse("listMiniApps", { miniApps: [{
        pluginId: "demo.miniapp",
        displayName: "演示应用",
        description: "一个用于浏览器验收的 Mini App",
        runtime: { kind: "process", status: "stopped" },
      }] });
      window.__fixture.setPluginManagementResult("listMarketplacePlugins", {
        pluginTotal: 4,
        plugins: [
          { name: "demo.miniapp", displayName: "演示应用", description: "一个用于浏览器验收的 Mini App", icon_url: "/mavis/api/file/preview?path=%2Fplugins%2Fdemo%2Ficon.svg", tags: [{ key: "miniapp" }] },
          { name: "minimax-stocks", displayName: "股市", description: "股市插件", tags: [{ key: "miniapp" }] },
          { name: "market-two", displayName: "Market two", description: "Marketplace card", tags: [{ key: "miniapp" }] },
          { name: "market-three", displayName: "Market three", description: "Marketplace card", tags: [{ key: "miniapp" }] },
          { name: "market-disabled", displayName: "Disabled Mini App", description: "Disabled Mini App", tags: [{ key: "miniapp" }] },
        ],
      });
      window.__fixture.setPluginManagementResult("listInstalledPlugins", {
        plugins: [
          { name: "demo.miniapp", displayName: "演示应用", description: "一个用于浏览器验收的 Mini App", source: 0, enabled: true },
          { name: "minimax-stocks", description: "股市插件", source: 0, enabled: true },
          { name: "market-two", displayName: "Market two", description: "Installed Mini App", source: 0, enabled: true },
          { name: "market-three", displayName: "Market three", description: "Installed Mini App", source: 0, enabled: true },
          { name: "market-disabled", displayName: "Disabled Mini App", description: "Disabled Mini App", source: 0, enabled: false },
        ],
      });
    });
  });
  await openApp(page);
  await page.getByRole("button", { name: "插件" }).first().click();
  await page.getByTestId("plugin-manage-trigger").click();
  await page.locator(".webui-plugin-category-filter").getByRole("button", { name: "应用" }).click();

  const apps = page.getByTestId("miniapp-apps");
  await expect(apps).toBeVisible();
  await expect(apps.getByTestId("miniapp-app-demo.miniapp")).toContainText("演示应用");
  await expect(apps.locator(".webui-plugin-row")).toHaveCount(5);
  const icon = apps.getByTestId("miniapp-app-demo.miniapp").locator("img");
  await expect(icon).toHaveAttribute("src", /\/workspace-file\?token=synthetic-token&dir=%2Fplugins%2Fdemo&path=icon\.svg/u);
  await expect.poll(() => icon.evaluate((image) => image.complete && image.naturalWidth > 0)).toBe(true);
  await expect(apps.getByTestId("miniapp-app-minimax-stocks").locator("h2")).toHaveText("股市");
  await expect(apps.getByTestId("miniapp-app-status-minimax-stocks")).toHaveAttribute("data-status", "unavailable");
  await expect(apps.getByTestId("miniapp-app-status-market-disabled")).toHaveAttribute("data-status", "disabled");
  await expect(apps.getByTestId("miniapp-app-market-disabled")).toContainText("已停用");
  // Enabling a disabled Mini App is the row's own switch, named 启用 <name>.
  await expect(apps.getByTestId("miniapp-app-market-disabled").getByRole("switch", { name: /^启用/u })).toBeVisible();
  await expect(apps.getByRole("button", { name: "安装 Mini App" })).toHaveCount(0);
});
