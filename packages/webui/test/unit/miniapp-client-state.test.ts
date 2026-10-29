// Mini App client state: the panel's tab kind and the business's owner.
//
// Two seams, one criterion each. The panel half proves that a `miniapp` tab is a
// tab like any other — it carries a session and a plugin, it is one tab per pair,
// and the launcher offers it — without the panel learning any Mini App state. The
// owner half proves the states the ticket names: a refusal is kept per plugin, a
// fourth start names the three that are running, a stop clears the view and says
// why, and nothing reopens on its own.
//
// The owner is driven against a scripted port. What that does *not* cover: the
// runtime's own capacity rule, the real start/stop path and the proxy. Those are
// covered where they live (`miniapp-operations.test.ts`, the proxy registry test),
// and this file's claims end at "given the runtime answered X, the client state is
// Y".

import { describe, expect, it, vi } from "vitest";

import {
  WEBUI_WORKSPACE_LAUNCHER_TILE_ORDER,
  WEBUI_WORKSPACE_TAB_KINDS,
  initialWorkspacePanelState,
  reduceWorkspacePanelState,
  webuiWorkspaceLauncherTiles,
  webuiWorkspaceTabContentKey,
  webuiWorkspaceTabLabel,
  type WorkspacePanelState,
} from "../../src/client/features/workspace/projection/workspace-panel-state.js";
import {
  createWebuiMiniAppWorkflows,
  type WebuiMiniAppPortSlice,
} from "../../src/client/features/miniapp/application/miniapp-workflows.js";
import {
  webuiMiniAppCapacityText,
  webuiMiniAppRefusalText,
  webuiMiniAppRows,
} from "../../src/client/features/miniapp/projection/miniapp-view.js";
import type {
  WebuiMiniAppCatalogueRow,
  WebuiMiniAppSummary,
} from "../../src/shared/contracts/miniapp.js";

const SESSION = "session-1";

function miniApp(
  pluginId: string,
  status: WebuiMiniAppSummary["runtime"]["status"],
  extra: Partial<WebuiMiniAppSummary & { detached: boolean; presentationRevision: number }> = {},
): WebuiMiniAppCatalogueRow {
  return {
    pluginId,
    displayName: `${pluginId} name`,
    runtime: { kind: "process", status },
    detached: false,
    presentationRevision: 0,
    ...extra,
  };
}

/** A port whose answers each case scripts. Counts the calls it received. */
function scriptedPort(input: {
  readonly miniApps: readonly WebuiMiniAppCatalogueRow[];
  readonly open: (pluginId: string) => Promise<{ pluginId: string; viewUrl: string }>;
  readonly stop?: (pluginId: string) => Promise<void>;
}): WebuiMiniAppPortSlice & {
  readonly calls: { readonly open: string[]; readonly stop: string[] };
  readonly listed: () => number;
} {
  const calls = { open: [] as string[], stop: [] as string[] };
  let listed = 0;
  return {
    calls,
    listed: () => listed,
    listMiniApps: async () => {
      listed += 1;
      return { miniApps: input.miniApps };
    },
    openMiniApp: async ({ pluginId }) => {
      calls.open.push(pluginId);
      return input.open(pluginId);
    },
    stopMiniApp: async ({ pluginId }) => {
      calls.stop.push(pluginId);
      await input.stop?.(pluginId);
      return { success: true as const };
    },
  };
}

describe("the workspace panel's miniapp tab kind", () => {
  it("opens a tab carrying the session and the plugin, and labels it by the plugin", () => {
    const state = reduceWorkspacePanelState(initialWorkspacePanelState, {
      type: "open-tab",
      kind: "miniapp",
      sessionId: SESSION,
      pluginId: "com.example.dashboard",
    });
    expect(state.tabs).toHaveLength(1);
    const tab = state.tabs[0]!;
    expect(tab.content).toEqual({
      kind: "miniapp",
      sessionId: SESSION,
      pluginId: "com.example.dashboard",
    });
    expect(webuiWorkspaceTabLabel(tab)).toBe("com.example.dashboard");
    expect(state.open).toBe(true);
    expect(state.activeTabId).toBe(tab.id);
  });

  it("opens nothing without a plugin or without a session", () => {
    // The launcher's own tile sends exactly this shape; it must not become an
    // empty frame.
    expect(
      reduceWorkspacePanelState(initialWorkspacePanelState, {
        type: "open-tab",
        kind: "miniapp",
        sessionId: SESSION,
      }),
    ).toBe(initialWorkspacePanelState);
    expect(
      reduceWorkspacePanelState(initialWorkspacePanelState, {
        type: "open-tab",
        kind: "miniapp",
        pluginId: "com.example.dashboard",
      }),
    ).toBe(initialWorkspacePanelState);
  });

  it("is one tab per plugin and session, and two tabs for two plugins", () => {
    const once = reduceWorkspacePanelState(initialWorkspacePanelState, {
      type: "open-tab",
      kind: "miniapp",
      sessionId: SESSION,
      pluginId: "a",
    });
    const twice = reduceWorkspacePanelState(once, {
      type: "open-tab",
      kind: "miniapp",
      sessionId: SESSION,
      pluginId: "a",
    });
    expect(twice.tabs).toHaveLength(1);
    expect(twice.activeTabId).toBe(once.tabs[0]!.id);

    const other = reduceWorkspacePanelState(twice, {
      type: "open-tab",
      kind: "miniapp",
      sessionId: SESSION,
      pluginId: "b",
    });
    expect(other.tabs).toHaveLength(2);
  });

  it("replaces the launcher tab it was opened from, keeping the tab's id", () => {
    const launcher = reduceWorkspacePanelState(initialWorkspacePanelState, { type: "open-new-tab" });
    const tabId = launcher.tabs[0]!.id;
    const state = reduceWorkspacePanelState(launcher, {
      type: "open-tab",
      kind: "miniapp",
      sessionId: SESSION,
      pluginId: "a",
      tabId,
    });
    expect(state.tabs).toHaveLength(1);
    expect(state.tabs[0]!.id).toBe(tabId);
    expect(state.tabs[0]!.content.kind).toBe("miniapp");
  });

  it("keys its content by the plugin, so two Mini Apps never share a cache slot", () => {
    const left = webuiWorkspaceTabContentKey({ kind: "miniapp", sessionId: SESSION, pluginId: "a" });
    const right = webuiWorkspaceTabContentKey({ kind: "miniapp", sessionId: SESSION, pluginId: "b" });
    expect(left).not.toBe(right);
    expect(left).toBe(`miniapp:${SESSION}:a`);
  });

  it("is a registry kind with a launcher tile, which is what makes it reachable", () => {
    // The Mini App's own page is opened by the choice made in the Mini App tool
    // page, so it has no tile of its own; the tile belongs to the tool page.
    expect(WEBUI_WORKSPACE_TAB_KINDS.miniapp.tile).toBeNull();
    expect(WEBUI_WORKSPACE_TAB_KINDS["miniapp-picker"].tile).toEqual({
      type: "open-tab",
      kind: "miniapp-picker",
    });
    expect(WEBUI_WORKSPACE_LAUNCHER_TILE_ORDER).toContain("miniapp-picker");
    const tile = webuiWorkspaceLauncherTiles().find((entry) => entry.kind === "miniapp-picker");
    expect(tile?.label).toBe("应用");
  });

  it("turns the tab the tile is on into the Mini App tool page, and the choice into the page", () => {
    const launcher = reduceWorkspacePanelState(initialWorkspacePanelState, { type: "open-new-tab" });
    const tabId = launcher.tabs[0]!.id;
    const picking = reduceWorkspacePanelState(launcher, {
      type: "open-tab",
      kind: "miniapp-picker",
      sessionId: SESSION,
      tabId,
    });
    // The tab is the tool page now — one tab, and it is not the launcher any
    // more, the way every other tile turns its tab into its own view.
    expect(picking.tabs).toHaveLength(1);
    expect(picking.tabs[0]!.id).toBe(tabId);
    expect(picking.tabs[0]!.content).toEqual({ kind: "miniapp-picker", sessionId: SESSION });

    const chosen = reduceWorkspacePanelState(picking, {
      type: "open-tab",
      kind: "miniapp",
      sessionId: SESSION,
      pluginId: "a",
      tabId,
    });
    expect(chosen.tabs).toHaveLength(1);
    expect(chosen.tabs[0]!.id).toBe(tabId);
    expect(chosen.tabs[0]!.content).toEqual({
      kind: "miniapp",
      sessionId: SESSION,
      pluginId: "a",
    });
  });
});

describe("the Mini App business", () => {
  it("maps the runtime's states to the row's words and keeps the failure code", async () => {
    const port = scriptedPort({
      miniApps: [
        miniApp("running-app", "running"),
        miniApp("failed-app", "failed", { runtime: { kind: "process", status: "failed", errorCode: "RUNTIME_START_FAILED" } }),
      ],
      open: async (pluginId) => ({ pluginId, viewUrl: "http://127.0.0.1:1" }),
    });
    const workflows = createWebuiMiniAppWorkflows({ port });
    await workflows.loadListing();
    const rows = workflows.getSnapshot().listing.rows;
    expect(rows.map((row) => row.statusLabel)).toEqual(["运行中", "启动失败"]);
    expect(rows[1]!.errorCode).toBe("RUNTIME_START_FAILED");
    expect(rows[0]!.running).toBe(true);
  });

  it("keeps an open view URL and stops showing it when the runtime stopped", async () => {
    const miniApps = [miniApp("app", "running")];
    const port = scriptedPort({
      miniApps,
      open: async (pluginId) => ({ pluginId, viewUrl: "http://127.0.0.1:41000" }),
    });
    const workflows = createWebuiMiniAppWorkflows({ port });
    expect(await workflows.open("app")).toBe(true);
    expect(workflows.getSnapshot().presentations.app).toEqual({
      kind: "open",
      viewUrl: "http://127.0.0.1:41000",
      // The fixture's host issues no generation, and the bridge records that as
      // the unaddressable one rather than inventing a number.
      connection: 0,
      // The lease revision travels with the presentation, because a frame that
      // carries a newer one replaces this one. The fixture's host issues no
      // revision either, so the unaddressable one is recorded here too.
      presentationRevision: 0,
    });

    // The runtime stops it while the view is up. One read reconciles the view.
    miniApps[0] = miniApp("app", "stopped");
    await workflows.syncPresentations();
    const presentation = workflows.getSnapshot().presentations.app;
    expect(presentation).toEqual({ kind: "stopped", reason: "运行已停止。" });
    // Nothing restarted it: a stopped runtime is reopened by a person, never by
    // the view noticing.
    expect(port.calls.open).toEqual(["app"]);
  });

  it("reports why a failed runtime's view was cleared", async () => {
    const miniApps = [miniApp("app", "running")];
    const port = scriptedPort({
      miniApps,
      open: async (pluginId) => ({ pluginId, viewUrl: "http://127.0.0.1:41001" }),
    });
    const workflows = createWebuiMiniAppWorkflows({ port });
    await workflows.open("app");
    miniApps[0] = miniApp("app", "failed", {
      runtime: { kind: "process", status: "failed", errorCode: "RUNNER_START_FAILED" },
    });
    await workflows.syncPresentations();
    expect(workflows.getSnapshot().presentations.app).toEqual({
      kind: "stopped",
      reason: "运行失败（进程启动失败）。",
    });
  });

  it("clears the view and says why when the person stops it", async () => {
    const port = scriptedPort({
      miniApps: [miniApp("app", "running")],
      open: async (pluginId) => ({ pluginId, viewUrl: "http://127.0.0.1:41002" }),
    });
    const workflows = createWebuiMiniAppWorkflows({ port });
    await workflows.open("app");
    await workflows.stop("app");
    expect(port.calls.stop).toEqual(["app"]);
    expect(workflows.getSnapshot().presentations.app).toEqual({
      kind: "stopped",
      reason: "运行已停止。",
    });
  });

  it("names the three running apps when a fourth start is refused, and lets one be stopped", async () => {
    const running = [miniApp("one", "running"), miniApp("two", "running"), miniApp("three", "running")];
    let refuses = true;
    const port = scriptedPort({
      miniApps: running,
      open: async (pluginId) => {
        if (refuses) throw Object.assign(new Error("Mini App surface action failed"), { code: "BUSY" });
        return { pluginId, viewUrl: "http://127.0.0.1:41003" };
      },
    });
    const workflows = createWebuiMiniAppWorkflows({ port });
    await workflows.loadListing();

    expect(await workflows.open("fourth")).toBe(false);
    const snapshot = workflows.getSnapshot();
    expect(snapshot.refusals.fourth).toEqual({ code: "BUSY", message: "Mini App surface action failed" });
    // The refusal names them rather than counting them: "3 running" is not
    // something a person can act on.
    const text = webuiMiniAppRefusalText({
      code: "BUSY",
      message: "Mini App surface action failed",
      rows: snapshot.listing.rows,
    });
    expect(text).toContain("one name");
    expect(text).toContain("two name");
    expect(text).toContain("three name");
    expect(text).toContain("请先停止一个");

    // Stopping one frees the capacity, and the same open then succeeds.
    refuses = false;
    await workflows.stop("one");
    expect(await workflows.open("fourth")).toBe(true);
    expect(workflows.getSnapshot().presentations.fourth?.kind).toBe("open");
  });

  it("reports an app another client owns, naming that client, in both surfaces' state", async () => {
    const port = scriptedPort({
      miniApps: [miniApp("shared-app", "stopped")],
      open: async () => {
        throw Object.assign(
          new Error("Mini App shared-app is already running in electron (pid 4242)"),
          { code: "OWNED_ELSEWHERE" },
        );
      },
    });
    const workflows = createWebuiMiniAppWorkflows({ port });
    await workflows.loadListing();
    expect(await workflows.open("shared-app")).toBe(false);

    const snapshot = workflows.getSnapshot();
    const refusal = snapshot.refusals["shared-app"];
    expect(refusal?.code).toBe("OWNED_ELSEWHERE");
    const text = webuiMiniAppRefusalText({
      code: refusal!.code,
      message: refusal!.message,
      rows: snapshot.listing.rows,
    });
    // The client and its pid are the runtime's to report — this client cannot
    // discover them, and must not invent them.
    expect(text).toContain("electron");
    expect(text).toContain("4242");
    expect(snapshot.presentations["shared-app"]).toBeUndefined();
  });

  it("is unavailable rather than empty when the host has no Mini App cell", () => {
    const workflows = createWebuiMiniAppWorkflows({ port: {} });
    expect(workflows.available).toBe(false);
    expect(workflows.getSnapshot().unavailable).toBeDefined();
    expect(webuiMiniAppRows([])).toEqual([]);
  });

  it("does not start anything when asked to reconcile an empty view set", async () => {
    const port = scriptedPort({
      miniApps: [miniApp("app", "stopped")],
      open: async (pluginId) => ({ pluginId, viewUrl: "http://127.0.0.1:1" }),
    });
    const workflows = createWebuiMiniAppWorkflows({ port });
    await workflows.syncPresentations();
    expect(port.calls.open).toEqual([]);
    expect(port.listed()).toBe(0);
  });

  it("routes the package lifecycle through the plugin management action", async () => {
    const invoke = vi.fn(async () => ({ success: true }));
    const workflows = createWebuiMiniAppWorkflows({
      port: {
        listMiniApps: async () => ({ miniApps: [] }),
        openMiniApp: async () => ({ pluginId: "x", viewUrl: "http://127.0.0.1:1" }),
        stopMiniApp: async () => ({ success: true as const }),
        pluginManagement: invoke as never,
      },
    });
    await workflows.setPluginEnabled("app", false);
    expect(invoke).toHaveBeenCalledWith({ action: "disablePlugin", input: { pluginName: "app" } });
    await workflows.uninstall("app");
    expect(invoke).toHaveBeenCalledWith({ action: "uninstallPlugin", input: { pluginName: "app" } });
  });
});

describe("the panel's own state stays layout", () => {
  it("holds no Mini App fact beyond the plugin a tab shows", () => {
    const state: WorkspacePanelState = reduceWorkspacePanelState(initialWorkspacePanelState, {
      type: "open-tab",
      kind: "miniapp",
      sessionId: SESSION,
      pluginId: "a",
    });
    expect(Object.keys(state.tabs[0]!.content).sort()).toEqual(["kind", "pluginId", "sessionId"]);
    expect(webuiMiniAppCapacityText([])).toContain("其他应用");
  });
});
