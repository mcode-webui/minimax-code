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

import { configureFixture, openApp, test } from "./harness.mjs";

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
      body: "<!doctype html><html><body><p>Mini App stub</p></body></html>",
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
  await openApp(page);
  await openWorkspacePanel(page);

  // The tile is on the new tab page, beside the tool views.
  const tile = page.getByTestId("workspace-launcher-tile-miniapp-picker");
  await expect(tile).toBeVisible();
  await expect(tile).toContainText("应用");
  await tile.click();

  // The tile turns this tab into the tool page, the way every other tile turns
  // it into its view: the new tab page is gone rather than keeping its tiles
  // with a picker underneath them.
  await expect(page.getByTestId("workspace-launcher-tab")).toHaveCount(0);
  await expect(page.getByTestId("workspace-miniapp-picker-tab")).toBeVisible();

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
  // The launcher tab became the Mini App tab; a second tab was not added.
  await expect(page.getByTestId("workspace-panel")).toHaveAttribute("data-active-tab", "miniapp");
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
  await page.getByTestId("workspace-launcher-tile-miniapp-picker").click();
  await page.getByTestId("miniapp-picker").getByRole("button", { name: "打开" }).click();

  await expect(page.getByTestId("miniapp-picker")).toContainText(
    "已在其他客户端运行：Mini App is already running in Desktop",
  );
  await expect(page.getByTestId("miniapp-view-frame")).toHaveCount(0);
  expect(
    await page.evaluate(() =>
      window.__fixture.requests.filter((request) => request.operation === "openMiniApp").length,
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
  await page.getByTestId("workspace-launcher-tile-miniapp-picker").click();
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
  await page.getByTestId("workspace-launcher-tile-miniapp-picker").click();
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
  await page.getByTestId("workspace-launcher-tile-miniapp-picker").click();

  const picker = page.getByTestId("miniapp-picker");
  await expect(picker.getByTestId("miniapp-picker-running")).toContainText("看板、笔记、画板");

  await picker.getByTestId("miniapp-picker-row-demo.fourth").getByRole("button", { name: "打开" }).click();
  const capacity = picker.getByTestId("miniapp-picker-capacity");
  await expect(capacity).toBeVisible();
  await expect(capacity).toContainText("同时最多运行 3 个 Mini App");
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
  await page.getByTestId("workspace-launcher-tile-miniapp-picker").click();

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
          { name: "demo.miniapp", displayName: "演示应用", description: "一个用于浏览器验收的 Mini App", icon_url: "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='2' height='2'%3E%3C/svg%3E", tags: [{ key: "miniapp" }] },
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
  await page.locator(".webui-plugin-manage-trigger").click();
  await page.locator(".webui-plugin-category-filter").getByRole("button", { name: "应用" }).click();

  const apps = page.getByTestId("miniapp-apps");
  await expect(apps).toBeVisible();
  await expect(apps.getByTestId("miniapp-app-demo.miniapp")).toContainText("演示应用");
  await expect(apps.locator(".webui-plugin-row")).toHaveCount(5);
  const icon = apps.getByTestId("miniapp-app-demo.miniapp").locator("img");
  await expect(icon).toHaveAttribute("src", /^data:image\/svg\+xml,/);
  await expect.poll(() => icon.evaluate((image) => image.naturalWidth)).toBeGreaterThan(0);
  await expect(apps.getByTestId("miniapp-app-minimax-stocks").locator("h2")).toHaveText("股市");
  await expect(apps.getByTestId("miniapp-app-status-minimax-stocks")).toHaveAttribute("data-status", "unavailable");
  await expect(apps.getByTestId("miniapp-app-status-market-disabled")).toHaveAttribute("data-status", "disabled");
  await expect(apps.getByTestId("miniapp-app-market-disabled")).toContainText("已停用");
  await expect(apps.getByTestId("miniapp-app-market-disabled").getByRole("button", { name: "启用" })).toBeVisible();
  await expect(apps.getByRole("button", { name: "安装 Mini App" })).toHaveCount(0);
});
