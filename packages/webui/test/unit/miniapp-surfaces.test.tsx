// The three published surfaces, and the proxy listeners behind them.
//
// The surfaces are server-rendered here rather than mounted: this package has no
// DOM framework by design, so a render branch is asserted through its markup.
// What that proves and what it does not is worth stating — it proves the panel
// frames the URL the open operation answered with, that a row renders the
// runtime's state, and that the surfaces keep the rows, the controls and the
// empty states they always had. It does not prove the page inside the frame
// loads, or that a click reaches a handler; the browser suite owns that.
//
// The failures and the confirmations are said through the shared toast (ADR
// 0030), which is raised in an effect and drawn over the page: a server render
// never sees it. So what a case pins about a failure here is that the layout
// does not carry transient errors — and, from the surfaces' own sources, that
// they are still reported at all. A failed start additionally leaves a persistent
// not-opened state with an explicit recovery control.
//
// The registry half is real: an actual upstream `http.Server`, an actual listener,
// and a close that has to free its port — because the whole reason it exists is
// that a leaked listener holds a port the next start derives again.

import { readFileSync } from "node:fs";
import http from "node:http";

import { describe, expect, it } from "vitest";
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { WebuiMiniAppWorkflowsProvider } from "../../src/client/features/miniapp/bindings/use-miniapp-workflows.js";
import {
  createWebuiMiniAppWorkflows,
  type WebuiMiniAppPortSlice,
} from "../../src/client/features/miniapp/application/miniapp-workflows.js";
import { MiniAppAppsList } from "../../src/client/features/miniapp/ui/MiniAppAppsList.public.js";
import { MiniAppPicker } from "../../src/client/features/miniapp/ui/MiniAppPicker.public.js";
import { MiniAppView } from "../../src/client/features/miniapp/ui/MiniAppView.public.js";
import { MiniAppStandalone } from "../../src/client/features/miniapp/ui/MiniAppStandalone.public.js";
import { createMiniAppProxyRegistry } from "../../src/server/miniapp/proxy-registry.js";
import { miniAppPageBridge } from "../../src/server/miniapp/bridge.js";
import type {
  WebuiMiniAppCatalogueRow,
  WebuiMiniAppPresentationState,
  WebuiMiniAppSummary,
} from "../../src/shared/contracts/miniapp.js";

function summary(
  pluginId: string,
  status: WebuiMiniAppSummary["runtime"]["status"],
  runtime: Partial<WebuiMiniAppSummary["runtime"]> = {},
  presentation: { detached?: boolean; presentationRevision?: number } = {},
): WebuiMiniAppCatalogueRow {
  return {
    pluginId,
    displayName: `${pluginId} 应用`,
    description: "说明",
    runtime: { kind: "process", status, ...runtime },
    detached: presentation.detached ?? false,
    presentationRevision: presentation.presentationRevision ?? 0,
  };
}

function port(input: {
  readonly miniApps: readonly WebuiMiniAppCatalogueRow[];
  readonly open?: (pluginId: string) => Promise<{ pluginId: string; viewUrl: string }>;
  readonly stop?: () => Promise<void>;
  readonly standaloneUrl?: (input: { pluginId: string; sessionId?: string }) => string;
  readonly permissions?: (
    pluginId: string,
  ) => Promise<{
    pluginId: string;
    source: "local" | "official";
    items: readonly { id: string; enabled: boolean }[];
  }>;
  readonly watch?: (
    request: { pluginId: string; sessionId?: string },
    onFrame: (state: WebuiMiniAppPresentationState) => void,
    onFailure?: (error: Error) => void,
  ) => () => void;
}): WebuiMiniAppPortSlice {
  return {
    listMiniApps: async () => ({ miniApps: input.miniApps }),
    openMiniApp: async ({ pluginId }) =>
      input.open ? input.open(pluginId) : { pluginId, viewUrl: "http://127.0.0.1:49152" },
    stopMiniApp: async () => {
      await input.stop?.();
      return { success: true as const };
    },
    ...(input.permissions ? { listMiniAppPermissions: input.permissions } : {}),
    ...(input.standaloneUrl ? { miniappStandaloneUrl: input.standaloneUrl } : {}),
    ...(input.watch ? { watchMiniAppPresentation: input.watch } : {}),
  };
}

function render(element: ReactElement, workflows: ReturnType<typeof createWebuiMiniAppWorkflows>): string {
  return renderToStaticMarkup(
    createElement(WebuiMiniAppWorkflowsProvider, { workflows, children: element }),
  );
}

describe("the plugin catalogue's apps area", () => {
  it("shows an opening state while the runtime starts a Mini App", async () => {
    let finishOpen!: (value: { pluginId: string; viewUrl: string }) => void;
    const workflows = createWebuiMiniAppWorkflows({
      port: port({
        miniApps: [summary("dashboard", "stopped")],
        open: () => new Promise((resolve) => {
          finishOpen = resolve;
        }),
      }),
    });

    const opening = workflows.open("dashboard");
    expect(workflows.getSnapshot().presentations.dashboard).toEqual({ kind: "opening" });

    finishOpen({ pluginId: "dashboard", viewUrl: "http://127.0.0.1:49152" });
    await opening;
    expect(workflows.getSnapshot().presentations.dashboard).toMatchObject({ kind: "open" });
  });

  it("clears a capacity refusal after another Mini App is stopped", async () => {
    const workflows = createWebuiMiniAppWorkflows({
      port: {
        listMiniApps: async () => ({ miniApps: [summary("dashboard", "running")] }),
        openMiniApp: async () => {
          throw Object.assign(new Error("capacity reached"), { code: "BUSY" });
        },
        stopMiniApp: async () => ({ success: true as const }),
      },
    });

    await workflows.open("fourth");
    expect(workflows.getSnapshot().refusals.fourth?.code).toBe("BUSY");
    await workflows.stop("dashboard");
    expect(workflows.getSnapshot().refusals.fourth).toBeUndefined();
  });

  it("lists the runtime's state and offers the lifecycle actions", async () => {
    const workflows = createWebuiMiniAppWorkflows({
      port: port({
        miniApps: [
          summary("dashboard", "running"),
          summary("failed-one", "failed", { errorCode: "RUNNER_START_FAILED" }),
        ],
      }),
    });
    await workflows.loadListing();
    const markup = render(createElement(MiniAppAppsList, {}), workflows);
    expect(markup).toContain("dashboard 应用");
    expect(markup).toContain("运行中");
    // The failure is said in words: the code names the failure for other
    // programs, and the person needs what it means.
    expect(markup).toContain("启动失败（进程启动失败）");
    // The row's actions are a menu, and its popup is portal-rendered only while
    // it is open: the rendered row carries the trigger and its name, the items
    // are pinned against the component's own source. Enabling is the row's
    // switch rather than a menu item.
    expect(markup).toContain('aria-label="dashboard 应用的更多操作"');
    expect(markup).toMatch(/role="switch"[^>]*aria-label="启用 dashboard 应用"/u);
    const appsListSource = readFileSync(
      new URL("../../src/client/features/miniapp/ui/MiniAppAppsList.public.tsx", import.meta.url),
      "utf8",
    );
    for (const action of [
      "data-testid={`miniapp-app-open-${row.pluginId}`}",
      "data-testid={`miniapp-app-stop-${row.pluginId}`}",
      "data-testid={`miniapp-app-permissions-${row.pluginId}`}",
    ]) {
      expect(appsListSource, `row menu lost ${action}`).toContain(action);
    }
    expect(appsListSource).toContain("卸载");
  });

  it("leaves the refusal another client owns to the toast, and keeps the row", async () => {
    const workflows = createWebuiMiniAppWorkflows({
      port: port({
        miniApps: [summary("shared", "stopped")],
        open: async () => {
          throw Object.assign(
            new Error("Mini App shared is already running in electron (pid 4242)"),
            { code: "OWNED_ELSEWHERE" },
          );
        },
      }),
    });
    await workflows.loadListing();
    await workflows.open("shared");
    const markup = render(createElement(MiniAppAppsList, {}), workflows);
    // The refusal is an event, not a state: it is said once, through the shared
    // toast, which is drawn over the page (ADR 0030). A server render never
    // sees it, so the row carries no trace of it.
    expect(markup).not.toContain("electron");
    expect(markup).not.toContain("4242");
    expect(markup).not.toContain("已在其他客户端运行");
    // The row itself survives: the app is still listed, with the state it has.
    expect(markup).toContain("shared 应用");
    expect(markup).toContain('data-testid="miniapp-app-status-shared"');
    expect(markup).toContain("已停止");
  });

  it("shows confirmed cross-client ownership before open and disables both launch actions", async () => {
    const workflows = createWebuiMiniAppWorkflows({
      port: port({
        miniApps: [summary("shared", "stopped", { ownership: "other-client", ownerClient: "electron" })],
      }),
    });
    await workflows.loadListing();

    const apps = render(createElement(MiniAppAppsList, {}), workflows);
    const picker = render(
      createElement(MiniAppPicker, {
        sessionId: "session-1",
        onOpened: () => undefined,
        onClose: () => undefined,
      }),
      workflows,
    );

    expect(apps).toContain("其他客户端运行中");
    expect(apps).not.toContain("electron");
    // Each attribute is asserted on its own: the row renders `data-testid`,
    // `aria-label`, `disabled` and `title`, and a substring that spans two of
    // them pins the attribute order instead of the state the test is about.
    // The launch item is inside the row's menu, so its disabled state is pinned
    // in the source: an owned-elsewhere row cannot be opened from here.
    const appsListSource = readFileSync(
      new URL("../../src/client/features/miniapp/ui/MiniAppAppsList.public.tsx", import.meta.url),
      "utf8",
    );
    expect(appsListSource).toMatch(/disabled=\{\s*state\.opening === row\.pluginId \|\| row\.ownedElsewhere\s*\}/u);
    expect(picker).toContain('data-testid="miniapp-picker-open-shared"');
    expect(picker).toMatch(/data-testid="miniapp-picker-open-shared"[^>]*disabled=""/u);
  });

  it("offers to stop a Mini App another client is running", async () => {
    const workflows = createWebuiMiniAppWorkflows({
      port: port({
        miniApps: [
          summary("shared", "stopped", { ownership: "other-client", ownerClient: "electron" }),
        ],
      }),
    });
    await workflows.loadListing();

    const picker = render(
      createElement(MiniAppPicker, {
        sessionId: "session-1",
        onOpened: () => undefined,
        onClose: () => undefined,
      }),
      workflows,
    );

    // The row identifies another client and still offers the action that ends the
    // Mini App: the process serving it can be stopped from here too.
    expect(picker).toContain("其他客户端运行中");
    expect(picker).not.toContain("electron");
    expect(picker).toContain('data-testid="miniapp-picker-stop-shared"');
    expect(picker).not.toMatch(/data-testid="miniapp-picker-stop-shared"[^>]*disabled=""/u);
  });

  it("offers 启用 for a disabled Mini App instead of a start it cannot do", async () => {
    const workflows = createWebuiMiniAppWorkflows({
      port: port({
        miniApps: [
          { ...summary("disabled-one", "stopped"), enabled: false },
          summary("enabled-one", "stopped"),
        ],
      }),
    });
    await workflows.loadListing();
    const markup = render(createElement(MiniAppAppsList, {}), workflows);
    // The disabled row is listed — that is what makes enabling it possible — and
    // says so rather than showing a runtime state it does not have.
    expect(markup).toContain("disabled-one 应用");
    expect(markup).toContain("已停用");
    expect(markup).toMatch(/role="switch"[^>]*aria-label="启用 disabled-one 应用"/u);
    // The enabled row keeps its start action, which lives in the row's menu.
    expect(markup).toContain("enabled-one 应用");
    const appsListSource = readFileSync(
      new URL("../../src/client/features/miniapp/ui/MiniAppAppsList.public.tsx", import.meta.url),
      "utf8",
    );
    expect(appsListSource).toContain(': "打开"');
  });

  it("offers standalone viewing only when the WebUI deep link has a selected session", async () => {
    const workflows = createWebuiMiniAppWorkflows({
      port: port({
        miniApps: [summary("dashboard", "stopped")],
        standaloneUrl: ({ pluginId, sessionId }) =>
          `http://127.0.0.1:4173/?plugin=${pluginId}&session=${sessionId}`,
      }),
    });
    await workflows.open("dashboard");

    const withoutSession = render(createElement(MiniAppAppsList, {}), workflows);
    expect(withoutSession).not.toContain('aria-label="查看"');

    const withSession = render(
      createElement(MiniAppAppsList, { selectedSessionId: "session-1" }),
      workflows,
    );
    // The standalone view is a row-menu item: it renders only after the page has
    // opened the app and the client has a session to link to, and the popup is
    // portal-rendered, so the source is what pins it.
    const appsListSource = readFileSync(
      new URL("../../src/client/features/miniapp/ui/MiniAppAppsList.public.tsx", import.meta.url),
      "utf8",
    );
    expect(appsListSource).toContain('opened?.kind === "open" && standaloneHref !== undefined');
    expect(appsListSource).toContain("在独立标签页中查看 Mini App");
    expect(withSession).toContain("dashboard 应用");
  });

  it("says the capability is absent through the toast, and shows the empty state", () => {
    const workflows = createWebuiMiniAppWorkflows({ port: { pluginManagement: async () => undefined } });
    const markup = render(createElement(MiniAppAppsList, {}), workflows);
    // The absent capability is an event, not a state: it is said once, through
    // the shared toast (ADR 0030), so the list keeps its own empty state.
    expect(markup).not.toContain("没有提供 Mini App 能力");
    expect(markup).toContain("暂无已安装的 Mini App");
    expect(markup).toContain('data-testid="miniapp-apps"');
  });
});

describe("the launcher's picker", () => {
  it("keeps the running rows when a fourth start is refused, and says the capacity through the toast", async () => {
    const running = [summary("one", "running"), summary("two", "running"), summary("three", "running")];
    const workflows = createWebuiMiniAppWorkflows({
      port: port({
        miniApps: running,
        open: async () => {
          throw Object.assign(new Error("Mini App surface action failed"), { code: "BUSY" });
        },
      }),
    });
    await workflows.loadListing();
    await workflows.open("fourth");
    const markup = render(
      createElement(MiniAppPicker, { onOpened: () => undefined }),
      workflows,
    );
    // The capacity that was reached is an event, not a state: it is said once,
    // through the shared toast, which is drawn over the page (ADR 0030). A
    // server render never sees it.
    expect(markup).not.toContain("同时最多运行 3 个 Mini App");
    expect(markup).not.toContain("请先停止一个");
    // The rows the picker can still show, it still shows.
    expect(markup).toContain("one 应用");
    expect(markup).toContain("three 应用");
    // Each running row carries the stop button that frees the capacity.
    expect(markup).toContain('data-testid="miniapp-picker-stop-one"');
    expect(markup).toContain("停止");
  });

  it("lists the installed Mini Apps and says so when there are none", async () => {
    const empty = createWebuiMiniAppWorkflows({ port: port({ miniApps: [] }) });
    await empty.loadListing();
    expect(render(createElement(MiniAppPicker, { onOpened: () => undefined }), empty)).toContain(
      "暂无已安装的 Mini App",
    );
  });
});

describe("the Mini App view the panel frames", () => {
  it("frames the view URL the open operation answered with, and nothing else", async () => {
    const workflows = createWebuiMiniAppWorkflows({
      port: port({ miniApps: [summary("dashboard", "running")] }),
    });
    await workflows.open("dashboard");
    const markup = render(
      createElement(MiniAppView, { pluginId: "dashboard", sessionId: "session-1" }),
      workflows,
    );
    expect(markup).toContain('data-testid="miniapp-view-frame"');
    expect(markup).toContain('src="http://127.0.0.1:49152"');
    expect(markup).toContain('data-state="open"');
    // No credential, origin or surface path reaches the markup.
    expect(markup).not.toContain("token");
    expect(markup).not.toContain("surface/");
  });

  it("offers the running Mini App its refresh, its stop and what the runtime is doing", async () => {
    const workflows = createWebuiMiniAppWorkflows({
      port: port({ miniApps: [summary("dashboard", "running")] }),
    });
    await workflows.open("dashboard");
    const markup = render(
      createElement(MiniAppView, { pluginId: "dashboard", sessionId: "session-1" }),
      workflows,
    );
    expect(markup).toContain('data-testid="miniapp-refresh"');
    expect(markup).toContain('data-testid="miniapp-stop"');
    expect(markup).toContain('data-testid="miniapp-view-status"');
    expect(markup).toContain("运行中");
    expect(markup).toContain("刷新");
    expect(markup).toContain("停止");
  });

  it("offers no runtime control for a view that is not running", async () => {
    const workflows = createWebuiMiniAppWorkflows({
      port: port({ miniApps: [summary("dashboard", "stopped")] }),
    });
    await workflows.loadListing();
    const markup = render(
      createElement(MiniAppView, { pluginId: "dashboard", sessionId: "session-1" }),
      workflows,
    );
    expect(markup).not.toContain('data-testid="miniapp-refresh"');
    expect(markup).not.toContain('data-testid="miniapp-stop"');
  });

  it("renders a cleared view with its button, and starts nothing on its own", async () => {
    let opens = 0;
    const workflows = createWebuiMiniAppWorkflows({
      port: {
        listMiniApps: async () => ({ miniApps: [summary("dashboard", "running")] }),
        openMiniApp: async ({ pluginId }) => {
          opens += 1;
          return { pluginId, viewUrl: "http://127.0.0.1:49152" };
        },
        stopMiniApp: async () => ({ success: true as const }),
      },
    });
    await workflows.open("dashboard");
    await workflows.stop("dashboard");
    const markup = render(
      createElement(MiniAppView, { pluginId: "dashboard", sessionId: "session-1" }),
      workflows,
    );
    expect(markup).toContain('data-state="stopped"');
    // The reason the app stopped is an event, not a state: it is said once,
    // through the shared toast, which is drawn over the page (ADR 0030).
    expect(markup).not.toContain("运行已停止。");
    // The retry the person can press is still here.
    expect(markup).toContain('data-testid="miniapp-reopen"');
    expect(markup).toContain("重新打开");
    expect(markup).not.toContain("miniapp-view-frame");
    // A render is not a restart: the person's button is.
    expect(opens).toBe(1);
  });

  it("keeps an actionable state after another client refuses the start", async () => {
    const workflows = createWebuiMiniAppWorkflows({
      port: port({
        miniApps: [summary("shared", "stopped")],
        open: async () => {
          throw Object.assign(new Error("Mini App shared is already running in electron (pid 99)"), {
            code: "OWNED_ELSEWHERE",
          });
        },
      }),
    });
    await workflows.loadListing();
    await workflows.open("shared");
    const markup = render(
      createElement(MiniAppView, { pluginId: "shared", sessionId: "session-1" }),
      workflows,
    );
    // The toast reports the attempt; the retained state gives a safe next step
    // without repeating the other process's details.
    expect(markup).not.toContain("pid 99");
    expect(markup).not.toContain("electron");
    expect(markup).not.toContain("miniapp-view-frame");
    // The view itself still renders, so there is a surface to look at.
    expect(markup).toContain('data-testid="miniapp-view"');
    expect(markup).toContain("应用尚未打开");
    expect(markup).toContain("请先在其他客户端关闭该应用，再重试。");
    expect(markup).toContain("重试打开应用");
  });

  it("does not offer a start retry for a refused stop without a presentation", async () => {
    const workflows = createWebuiMiniAppWorkflows({
      port: port({
        miniApps: [summary("shared", "running")],
        stop: async () => { throw new Error("Stop was refused"); },
      }),
    });
    await workflows.stop("shared");
    const markup = render(createElement(MiniAppView, { pluginId: "shared" }), workflows);
    expect(workflows.getSnapshot().refusals.shared?.message).toBe("Stop was refused");
    expect(markup).not.toContain("应用尚未打开");
    expect(markup).not.toContain("重试打开应用");
  });

  it("retains a preparation failure until an explicit retry succeeds", async () => {
    let succeeds = false;
    const workflows = createWebuiMiniAppWorkflows({
      port: port({
        miniApps: [summary("shared", "stopped")],
        open: async () => {
          if (!succeeds) throw Object.assign(new Error("Mini App publication preparation failed"), {
            code: "MINIAPP_PREPARATION_FAILED",
          });
          return { pluginId: "shared", viewUrl: "http://127.0.0.1:49152" };
        },
      }),
    });
    await workflows.open("shared");
    const view = createElement(MiniAppView, { pluginId: "shared", surface: "standalone" });
    const failed = render(view, workflows);
    expect(failed).toContain("应用尚未打开");
    expect(failed).toContain("Mini App publication preparation failed");
    expect(failed).toContain("重试打开应用");
    expect(failed).not.toContain("请先在其他客户端关闭");
    expect(failed).not.toContain("miniapp-view-frame");
    succeeds = true;
    await workflows.open("shared");
    const recovered = render(view, workflows);
    expect(recovered).toContain("miniapp-view-frame");
    expect(recovered).not.toContain("应用尚未打开");
    expect(recovered).not.toContain("重试打开应用");
  });
});

describe("the standalone presentation's controls", () => {
  const PLUGIN = "dashboard";
  const SESSION = "session-1";
  const STANDALONE_URL = `http://127.0.0.1:4123/miniapp?token=t&plugin=${PLUGIN}&session=${SESSION}`;

  function standalonePort(
    presentation: { detached: boolean; presentationRevision: number },
  ): WebuiMiniAppPortSlice {
    return port({
      miniApps: [summary(PLUGIN, "running", {}, presentation)],
      standaloneUrl: ({ pluginId, sessionId }) =>
        `http://127.0.0.1:4123/miniapp?token=t&plugin=${pluginId}&session=${sessionId}`,
    });
  }

  it("offers the move from the inline view", async () => {
    const workflows = createWebuiMiniAppWorkflows({ port: standalonePort({ detached: false, presentationRevision: 0 }) });
    await workflows.open(PLUGIN);
    const markup = render(
      createElement(MiniAppView, { pluginId: PLUGIN, sessionId: SESSION }),
      workflows,
    );

    // The control names the action, and the URL it would open is the service's own
    // deep link — the client never assembles a Mini App origin.
    expect(markup).toContain('data-testid="miniapp-open-standalone"');
    expect(markup).toContain("在新标签页中打开");
    expect(markup).toContain('data-detached="false"');
    expect(workflows.standaloneUrl({ pluginId: PLUGIN, sessionId: SESSION })).toBe(STANDALONE_URL);
  });

  it("reports a live standalone presentation instead of framing a second one", async () => {
    const workflows = createWebuiMiniAppWorkflows({
      port: standalonePort({ detached: true, presentationRevision: 1 }),
    });
    await workflows.loadListing();
    await workflows.open(PLUGIN);
    const markup = render(
      createElement(MiniAppView, { pluginId: PLUGIN, sessionId: SESSION }),
      workflows,
    );

    expect(markup).toContain('data-detached="true"');
    expect(markup).toContain('data-testid="miniapp-view-detached"');
    expect(markup).toContain("已在独立的浏览器标签页中打开");
    expect(markup).toContain('data-testid="miniapp-switch-standalone"');
    expect(markup).toContain("切换到该标签页");
    // One presentation at a time: no frame, and no second-tab control.
    expect(markup).not.toContain("miniapp-view-frame");
    expect(markup).not.toContain('data-testid="miniapp-open-standalone"');
  });

  it("renders only the Mini App on the standalone surface, with no way back", async () => {
    const workflows = createWebuiMiniAppWorkflows({
      port: {
        ...standalonePort({ detached: true, presentationRevision: 1 }),
        watchMiniAppPresentation: (request, onFrame) => {
          onFrame({
            pluginId: request.pluginId,
            sessionId: request.sessionId,
            presentationRevision: 1,
            session: "live",
          });
          return () => undefined;
        },
      },
    });
    await workflows.loadListing();
    await workflows.open(PLUGIN);
    // The surface claims the lease in an effect, which SSR does not run, so the
    // state is established the way the effect establishes it. That the effect
    // itself fires is the browser suite's half.
    const release = workflows.claimStandalone({ pluginId: PLUGIN, sessionId: SESSION });
    const markup = render(
      createElement(MiniAppStandalone, { pluginId: PLUGIN, sessionId: SESSION }),
      workflows,
    );
    release();

    expect(markup).toContain('data-testid="miniapp-standalone"');
    expect(markup).toContain('data-testid="miniapp-view-frame"');
    // The standalone page is not the inline one: it does not report itself as
    // elsewhere, and it offers neither the move nor a way back (closing the tab is
    // the only way back, so an in-page control would be a second one).
    expect(markup).not.toContain('data-testid="miniapp-view-detached"');
    expect(markup).not.toContain('data-testid="miniapp-open-standalone"');
    expect(markup).not.toContain('data-testid="miniapp-switch-standalone"');
    expect(markup).not.toContain("切换到该标签页");
    expect(markup).not.toContain("在新标签页中打开");
  });

  it("keeps showing the Mini App when the deep link names an ended session", async () => {
    const workflows = createWebuiMiniAppWorkflows({
      port: {
        ...standalonePort({ detached: true, presentationRevision: 2 }),
        watchMiniAppPresentation: (request, onFrame) => {
          onFrame({
            pluginId: request.pluginId,
            sessionId: request.sessionId,
            presentationRevision: 2,
            session: "ended",
          });
          return () => undefined;
        },
      },
    });
    await workflows.loadListing();
    await workflows.open(PLUGIN);
    const release = workflows.claimStandalone({ pluginId: PLUGIN, sessionId: SESSION });
    const markup = render(
      createElement(MiniAppStandalone, { pluginId: PLUGIN, sessionId: SESSION }),
      workflows,
    );
    release();

    expect(markup).toContain('data-testid="miniapp-standalone-session-ended"');
    expect(markup).toContain("该会话已结束");
    // Reported, not enforced: the app is plugin-scoped and still renders.
    expect(markup).toContain('data-testid="miniapp-view-frame"');
  });

  it("says a refused session lookup as unresolved, never as ended", async () => {
    const workflows = createWebuiMiniAppWorkflows({
      port: {
        ...standalonePort({ detached: true, presentationRevision: 3 }),
        watchMiniAppPresentation: (_request, _onFrame, onFailure) => {
          onFailure?.(new Error("harness unavailable"));
          return () => undefined;
        },
      },
    });
    await workflows.loadListing();
    await workflows.open(PLUGIN);
    const release = workflows.claimStandalone({ pluginId: PLUGIN, sessionId: SESSION });
    const markup = render(
      createElement(MiniAppStandalone, { pluginId: PLUGIN, sessionId: SESSION }),
      workflows,
    );
    release();

    // The lookup that failed is an event, not a state: it is said once,
    // through the shared toast, which is drawn over the page (ADR 0030). A
    // server render never sees it, so the page carries no trace of the reason.
    expect(markup).not.toContain('data-testid="miniapp-standalone-session-unresolved"');
    expect(markup).not.toContain("无法确认会话状态");
    expect(markup).not.toContain("harness unavailable");
    // It is never read as an ended session either.
    expect(markup).not.toContain("该会话已结束");
    // The page keeps the Mini App it frames.
    expect(markup).toContain('data-testid="miniapp-standalone"');
    expect(markup).toContain('data-testid="miniapp-view-frame"');
  });
});

describe("the proxy registry", () => {
  it("attempts every registration and retains all shutdown failures", async () => {
    const attempted: string[] = [];
    const failures = [new Error("first proxy close failed"), new Error("second proxy close failed")];
    const registry = createMiniAppProxyRegistry({ start: async (registration) => {
      const id = registration.target.pluginId;
      return { pluginId: id, close: async () => { attempted.push(id); throw failures[id === "first" ? 0 : 1]; } } as never;
    } });
    for (const pluginId of ["first", "second"]) await registry.start({ target: { pluginId } } as never);
    const result = await registry.closeAll().catch((error: unknown) => error);
    expect(result).toBeInstanceOf(AggregateError);
    expect((result as AggregateError).errors).toEqual(failures);
    expect(attempted).toEqual(["first", "second"]);
    expect(registry.running()).toEqual([]);
  });
  it("binds a listener per plugin, serves the bridge, and frees every port on close", async () => {
    const upstream = http.createServer((request, response) => {
      response.writeHead(200, { "content-type": "text/html" });
      response.end("<html><head></head><body>dashboard</body></html>");
    });
    await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", () => resolve()));
    const address = upstream.address();
    const upstreamPort = typeof address === "object" && address ? address.port : 0;

    const registry = createMiniAppProxyRegistry({ port: 0 });
    const proxy = await registry.start({
      target: {
        pluginId: "registry.case",
        upstreamOrigin: `http://127.0.0.1:${upstreamPort}`,
        surfacePath: "/",
        credential: "credential-value",
        credentialHeader: "x-mavis-miniapp-token",
      },
      bridge: miniAppPageBridge("registry.case"),
    });
    expect(registry.running()).toHaveLength(1);

    const body = await new Promise<string>((resolve, reject) => {
      http.get(`${proxy.viewUrl}/`, (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
      }).on("error", reject);
    });
    // The bridge is in the document, before the page's own scripts.
    expect(body).toContain("/__miniapp/registry.case/bridge.js");
    expect(body.indexOf("/__miniapp/registry.case/bridge.js")).toBeLessThan(
      body.indexOf("dashboard"),
    );

    const freedPort = proxy.port;
    await registry.closeAll();
    expect(registry.running()).toHaveLength(0);

    // The port is free again: that is the property the shutdown path buys.
    const rebound = http.createServer(() => undefined);
    await new Promise<void>((resolve, reject) => {
      rebound.once("error", reject);
      rebound.listen(freedPort, "127.0.0.1", () => resolve());
    });
    await new Promise<void>((resolve) => rebound.close(() => resolve()));
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
  });
});

/**
 * Review finding F1: an inline view mounted while a standalone tab holds the lease.
 *
 * The surface was rendered with `detached: true` and no local presentation, so the
 * mount declined to start anything. When that tab closes, nothing reads the
 * catalogue for this view: the open-presentation poll needs a local `open`, and
 * `syncPresentations` returns without a read when the client holds none. The
 * notice therefore outlives the lease.
 */
describe("a detached view whose standalone tab goes away", () => {
  const PLUGIN = "dashboard";
  const SESSION = "session-1";

  function leasePort(input: {
    readonly detached: () => boolean;
    /** The runtime state the fresh catalogue answers with. Running by default. */
    readonly status?: () => WebuiMiniAppSummary["runtime"]["status"];
  }) {
    let opens = 0;
    const port: WebuiMiniAppPortSlice = {
      listMiniApps: async () => ({
        miniApps: [
          summary(
            PLUGIN,
            input.status?.() ?? "running",
            {},
            { detached: input.detached(), presentationRevision: 1 },
          ),
        ],
      }),
      openMiniApp: async ({ pluginId }) => {
        opens += 1;
        return { pluginId, viewUrl: "http://127.0.0.1:49152" };
      },
      stopMiniApp: async () => ({ success: true as const }),
    };
    return { port, opens: () => opens };
  }

  function renderInline(workflows: ReturnType<typeof createWebuiMiniAppWorkflows>): string {
    return render(
      createElement(MiniAppView, { pluginId: PLUGIN, sessionId: SESSION }),
      workflows,
    );
  }

  it("clears the notice and presents the Mini App again once the lease is released", async () => {
    let detached = true;
    const { port, opens } = leasePort({ detached: () => detached });
    const workflows = createWebuiMiniAppWorkflows({ port });

    // The mount's own read: another document is presenting this Mini App.
    await workflows.loadListing();
    const waiting = renderInline(workflows);
    expect(waiting).toContain('data-testid="miniapp-view-detached"');
    expect(waiting).not.toContain("miniapp-view-frame");
    expect(opens()).toBe(0);

    // The standalone tab closes. Its socket is gone, so the record is released.
    detached = false;
    // The view holds no presentation of its own, so `syncPresentations` has
    // nothing to reconcile: this is the read the mount still owed, and the stale
    // row is why the notice used to outlive the lease.
    await workflows.syncPresentations();
    expect(workflows.getSnapshot().listing.rows[0]?.detached).toBe(true);
    const stale = renderInline(workflows);
    expect(stale).toContain('data-testid="miniapp-view-detached"');
    expect(stale).not.toContain("miniapp-view-frame");

    expect(await workflows.presentInline(PLUGIN)).toBe("presented");

    const resumed = renderInline(workflows);
    expect(resumed).not.toContain('data-testid="miniapp-view-detached"');
    expect(resumed).not.toContain('data-detached="true"');
    expect(resumed).toContain('data-testid="miniapp-view-frame"');
    expect(workflows.getSnapshot().listing.rows[0]?.detached).toBe(false);
    expect(workflows.getSnapshot().presentations[PLUGIN]?.kind).toBe("open");
    expect(opens()).toBe(1);
  });

  it("does not reopen an app another document stopped while it waits", async () => {
    // The cross-document lifecycle: this view is waiting on a lease another document
    // holds, and the person stops the app there. The next catalogue answer has the
    // lease released *and* a stopped runtime, which is a terminal state this client
    // never asked for — #256's rule is that it is reported, not reconnected.
    let detached = true;
    let status: WebuiMiniAppSummary["runtime"]["status"] = "running";
    const { port, opens } = leasePort({ detached: () => detached, status: () => status });
    const workflows = createWebuiMiniAppWorkflows({ port });

    await workflows.loadListing();
    expect(await workflows.presentInline(PLUGIN)).toBe("waiting");
    expect(opens()).toBe(0);

    detached = false;
    status = "stopped";

    expect(await workflows.presentInline(PLUGIN)).toBe("blocked");
    expect(opens()).toBe(0);
    // The stop is reported rather than swallowed: the reason is said through
    // the shared toast (ADR 0030), and the retry the surface offers is the
    // person's.
    const stopped = renderInline(workflows);
    expect(stopped).not.toContain("运行已停止");
    expect(stopped).toContain('data-testid="miniapp-reopen"');
    expect(stopped).toContain("重新打开");
    expect(stopped).not.toContain("miniapp-view-frame");
    // Every later tick is terminal too: the poll cannot become a restart.
    expect(await workflows.presentInline(PLUGIN)).toBe("blocked");
    expect(opens()).toBe(0);
    // Explicit retry still works.
    expect(await workflows.open(PLUGIN)).toBe(true);
    expect(opens()).toBe(1);
  });

  it("does not restart a refused or stopped Mini App while it waits", async () => {
    // The loop asks repeatedly, so the refusal/stop rule has to live in the owner
    // rather than in the component's memory: a person restarts these, not a timer.
    const refused = createWebuiMiniAppWorkflows({
      port: {
        listMiniApps: async () => ({
          miniApps: [summary(PLUGIN, "stopped", {}, { detached: false, presentationRevision: 0 })],
        }),
        openMiniApp: async () => {
          throw Object.assign(new Error("Mini App surface action failed"), { code: "BUSY" });
        },
        stopMiniApp: async () => ({ success: true as const }),
      },
    });
    expect(await refused.presentInline(PLUGIN)).toBe("blocked");
    expect(await refused.presentInline(PLUGIN)).toBe("blocked");

    let stops = 0;
    const stopped = createWebuiMiniAppWorkflows({
      port: {
        listMiniApps: async () => ({
          miniApps: [summary(PLUGIN, "running", {}, { detached: false, presentationRevision: 1 })],
        }),
        openMiniApp: async ({ pluginId }) => ({ pluginId, viewUrl: "http://127.0.0.1:49152" }),
        stopMiniApp: async () => {
          stops += 1;
          return { success: true as const };
        },
      },
    });
    await stopped.open(PLUGIN);
    await stopped.stop(PLUGIN);
    expect(stops).toBe(1);
    // Stopped by the person: the loop must not bring it back.
    expect(await stopped.presentInline(PLUGIN)).toBe("blocked");
    expect(stopped.getSnapshot().presentations[PLUGIN]?.kind).toBe("stopped");
  });

  it("refreshes an open connection generation when an inline view is mounted again", async () => {
    let connection = 0;
    let opens = 0;
    let detached = false;
    let presentationRevision = 0;
    const workflows = createWebuiMiniAppWorkflows({
      port: {
        listMiniApps: async () => ({
          miniApps: [summary(PLUGIN, "running", {}, { detached, presentationRevision })],
        }),
        openMiniApp: async ({ pluginId }) => {
          opens += 1;
          connection += 1;
          return { pluginId, viewUrl: "http://127.0.0.1:49152", connection };
        },
        stopMiniApp: async () => ({ success: true as const }),
      },
    });

    expect(await workflows.open(PLUGIN)).toBe(true);
    expect(workflows.getSnapshot().presentations[PLUGIN]).toMatchObject({ connection: 1 });

    // Another document replaces the service connection while holding its lease.
    detached = true;
    presentationRevision = 1;
    await workflows.loadListing();
    await workflows.refreshInline(PLUGIN);
    expect(opens).toBe(1);

    // When that lease ends, the mounted inline view sees the revision change and
    // reacquires the connection instead of sending bridge calls through the old id.
    detached = false;
    await workflows.loadListing();
    await workflows.refreshInline(PLUGIN);
    expect(workflows.getSnapshot().presentations[PLUGIN]).toMatchObject({ connection: 2 });
    expect(opens).toBe(2);
  });

  it("waits through a standalone lease reconnect before reopening the inline view", async () => {
    let connection = 0;
    let opens = 0;
    let detached = false;
    let presentationRevision = 0;
    let reconnectionInProgress = false;
    let confirmationReads = 0;
    const workflows = createWebuiMiniAppWorkflows({
      port: {
        listMiniApps: async () => {
          if (reconnectionInProgress) {
            confirmationReads += 1;
            if (confirmationReads > 1) {
              detached = true;
              presentationRevision += 1;
            }
          }
          return {
            miniApps: [summary(PLUGIN, "running", {}, { detached, presentationRevision })],
          };
        },
        openMiniApp: async ({ pluginId }) => {
          opens += 1;
          connection += 1;
          return { pluginId, viewUrl: "http://127.0.0.1:49152", connection };
        },
        stopMiniApp: async () => ({ success: true as const }),
      },
    });

    expect(await workflows.open(PLUGIN)).toBe(true);
    detached = false;
    presentationRevision = 1;
    await workflows.loadListing();
    reconnectionInProgress = true;

    await workflows.refreshInline(PLUGIN);

    expect(confirmationReads).toBe(2);
    expect(opens).toBe(1);
    expect(workflows.getSnapshot().presentations[PLUGIN]).toMatchObject({ connection: 1 });
  });
});

describe("the device access a Mini App is framed with", () => {
  // The frame's `allow` attribute is the browser's own gate: a document without it
  // cannot reach the device, whatever the page inside asks for. That makes it the
  // one place a `device:*` switch takes effect on the client.
  const list = (items: readonly { id: string; enabled: boolean }[]) =>
    async (pluginId: string) => ({ pluginId, source: "official" as const, items });

  async function framed(permissions?: ReturnType<typeof list>): Promise<string> {
    const workflows = createWebuiMiniAppWorkflows({
      port: port({ miniApps: [summary("pet", "running")], permissions }),
    });
    await workflows.loadListing();
    await workflows.open("pet");
    return render(
      createElement(MiniAppView, { pluginId: "pet", sessionId: "session-1" }),
      workflows,
    );
  }

  it("frames the page with the microphone when the package's switch is on", async () => {
    const markup = await framed(list([{ id: "device:microphone", enabled: true }]));

    expect(markup).toContain("miniapp-view-frame");
    expect(markup).toContain('allow="microphone"');
  });

  it("frames it without the microphone once the switch is off", async () => {
    const markup = await framed(list([{ id: "device:microphone", enabled: false }]));

    expect(markup).toContain("miniapp-view-frame");
    expect(markup).not.toContain("microphone");
  });

  it("asks for nothing when the package declares no device", async () => {
    const markup = await framed(list([{ id: "agent:session.run", enabled: true }]));

    expect(markup).toContain("miniapp-view-frame");
    expect(markup).not.toContain("microphone");
  });

  it("opens the page with no device when the host cannot report switches", async () => {
    // No port method means no answer, and no answer must not read as a grant.
    expect(await framed(undefined)).not.toContain("microphone");
  });

  it("remounts the frame when the switch changes, because the browser reads it once", async () => {
    // The feature policy is latched at navigation: changing the attribute on a
    // loaded document changes nothing, so the frame has to be replaced.
    let microphone = true;
    const items = () => [{ id: "device:microphone", enabled: microphone }];
    const workflows = createWebuiMiniAppWorkflows({
      port: {
        ...port({ miniApps: [summary("pet", "running")] }),
        listMiniAppPermissions: async (pluginId: string) => ({
          pluginId,
          source: "official" as const,
          items: items(),
        }),
        setMiniAppPermission: async ({
          pluginId,
          permission,
          enabled,
        }: {
          pluginId: string;
          permission: string;
          enabled: boolean;
        }) => {
          if (permission === "device:microphone") microphone = enabled;
          return { pluginId, source: "official" as const, items: items() };
        },
      },
    });
    await workflows.loadListing();
    await workflows.open("pet");
    const before = render(
      createElement(MiniAppView, { pluginId: "pet", sessionId: "session-1" }),
      workflows,
    );

    await workflows.setPermission("pet", "device:microphone", false);
    const after = render(
      createElement(MiniAppView, { pluginId: "pet", sessionId: "session-1" }),
      workflows,
    );

    expect(before).toContain('allow="microphone"');
    expect(after).not.toBe(before);
    expect(after).not.toContain('allow="microphone"');
  });
});

/* The failures these surfaces carry are said through the shared toast (ADR
 * 0030). The toast is raised in an effect and drawn over the page, so a server
 * render never sees it: the surfaces' own sources are what pin that the
 * failures are reported at all, and not merely hidden. */
describe("the Mini App surfaces report their failures through the toast", () => {
  const source = (file: string): string =>
    readFileSync(
      new URL(`../../src/client/features/miniapp/ui/${file}`, import.meta.url),
      "utf8",
    );

  it("raises the refusal, the absent capability and the capacity through the toast", () => {
    const apps = source("MiniAppAppsList.public.tsx");
    expect(apps).toContain("useWebuiToastError(");
    expect(apps).toContain("miniapp-app-refusal-");
    expect(apps).toContain("state.unavailable");
    // And the list draws neither of them in its own layout any more.
    expect(apps).not.toContain("FeedbackError");

    const picker = source("MiniAppPicker.public.tsx");
    expect(picker).toContain("useWebuiToastError(");
    expect(picker).toContain("miniapp-picker-capacity");
    expect(picker).not.toContain("FeedbackError");
  });

  it("raises the stopped reason, the refusal and the unresolved session through the toast", () => {
    const view = source("MiniAppView.public.tsx");
    expect(view).toContain("useWebuiToastError(");
    expect(view).toContain("miniapp-view-stopped");
    expect(view).toContain("miniapp-view-refusal");
    expect(view).not.toContain("FeedbackError");

    const standalone = source("MiniAppStandalone.public.tsx");
    expect(standalone).toContain("useWebuiToastError(");
    expect(standalone).toContain("miniapp-standalone-session-unresolved");
    expect(standalone).not.toContain("FeedbackError");
  });
});
