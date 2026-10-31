// The workspace panel's tab strip, and the new tab page it opens.
//
// What is pinned here is the contract that has to survive the strip's
// authors changing their minds later: tool tabs and web tabs render in
// one row, the per-tab close button stays on the strip, the new tab
// affordance opens a fresh new tab page rather than another tool tab, and
// the web tabs the strip shows come from the runtime's snapshot — never a
// parallel copy the client keeps.
//
// The launcher is the other half of the same issue: four tiles and a URL box,
// both of which replace the tab's content in place, and the URL box reaches
// the runtime through the browser business's port.
//
// Rendered with `renderToStaticMarkup`, which runs no effects — so the
// subscription to `watchBrowserWebTabs` is exercised by the exported
// `webuiWorkspaceTabStripReconcile` helper, the same code the effect
// drives when a DOM is present, and a tile's dispatch by the exported
// `webuiWorkspaceLauncherTileCommand`.

import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import type {
  WebuiBrowserTargetId,
  WebuiBrowserWebTab,
  WebuiBrowserWebTabSnapshot,
} from "../../src/shared/contracts/browser.js";
import {
  WebuiWorkspaceLauncher,
  WebuiWorkspaceTabStrip,
  webuiWorkspaceLauncherOpenPage,
  webuiWorkspaceLauncherTileCommand,
  webuiWorkspaceLauncherUrl,
  webuiWorkspaceTabStripReconcile,
} from "../../src/client/features/workspace/ui/WebuiWorkspaceTabStrip.public.js";
import { WebuiPortSlicesProvider } from "../../src/client/bindings/port-slices-context.js";
import { createWebuiPortSlices } from "../../src/client/application/port-slices.js";
import {
  initialWorkspacePanelState,
  reduceWorkspacePanelState,
  webuiWorkspaceLauncherTiles,
  type WorkspacePanelCommand,
  type WorkspacePanelState,
  type WorkspacePanelTab,
} from "../../src/client/features/workspace/projection/workspace-panel-state.js";

function target(overrides: Partial<WebuiBrowserTargetId> = {}): WebuiBrowserTargetId {
  return {
    surface: "isolated-chromium",
    browserId: "browser-1",
    targetId: "tab-9",
    generation: 1,
    ...overrides,
  };
}

function webTab(overrides: Partial<WebuiBrowserWebTab> = {}): WebuiBrowserWebTab {
  return {
    id: `${overrides.target?.browserId ?? "browser-1"}/${overrides.target?.targetId ?? "tab-9"}`,
    target: target(),
    title: "Example",
    url: "https://example.test/",
    selected: false,
    ...overrides,
  };
}

function stateWithTabs(tabs: WorkspacePanelState["tabs"], activeTabId?: string): WorkspacePanelState {
  const merged = reduceWorkspacePanelState(initialWorkspacePanelState, {
    type: "open-tab",
    kind: "files",
    sessionId: "session-1",
    workspaceDir: "/work",
  });
  return { ...merged, tabs, activeTabId };
}

function launcherTab(id = "tab-9"): WorkspacePanelTab {
  return { id, content: { kind: "launcher" } };
}

function renderLauncher(
  tab: WorkspacePanelTab,
  port: Parameters<typeof createWebuiPortSlices>[0] = {},
): string {
  return renderToStaticMarkup(
    <WebuiPortSlicesProvider slices={createWebuiPortSlices(port)}>
      <WebuiWorkspaceLauncher
        tab={tab}
        dispatch={() => undefined}
        sessionId="session-1"
        workspaceDir="/work"
      />
    </WebuiPortSlicesProvider>,
  );
}

describe("the workspace panel's tab strip", () => {
  it("shows the globe glyph on the new tab page tab", () => {
    const state = stateWithTabs([launcherTab("tab-launcher")], "tab-launcher");
    const markup = renderToStaticMarkup(
      <WebuiPortSlicesProvider slices={createWebuiPortSlices({})}>
        <WebuiWorkspaceTabStrip state={state} dispatch={() => undefined} />
      </WebuiPortSlicesProvider>,
    );

    expect(markup).toContain('data-tab-kind="launcher"');
    expect(markup).toContain("webui-workspace-web-glyph");
    // The globe is the tabler world icon now; it used to be drawn by hand, so
    // the assertion names the icon rather than the shape it is made of.
    expect(markup).toContain("tabler-icon-world");
  });

  it("renders tool tabs and web tabs in one row", () => {
    const state = stateWithTabs([
      { id: "tab-1", content: { kind: "files", sessionId: "session-1", workspaceDir: "/work" } },
      {
        id: "tab-2",
        content: {
          kind: "web",
          target: target({ browserId: "browser-2", targetId: "tab-1" }),
          title: "Example",
          url: "https://example.test/",
        },
      },
    ], "tab-2");

    const markup = renderToStaticMarkup(
      <WebuiPortSlicesProvider slices={createWebuiPortSlices({})}>
        <WebuiWorkspaceTabStrip state={state} dispatch={() => undefined} />
      </WebuiPortSlicesProvider>,
    );

    expect(markup).toContain('data-tab-kind="files"');
    expect(markup).toContain('data-tab-kind="web"');
    expect(markup).toContain("Example");
  });

  it("labels a web tab by the page's title and shows a default glyph", () => {
    const state = stateWithTabs([
      {
        id: "tab-1",
        content: {
          kind: "web",
          target: target({ browserId: "browser-2", targetId: "tab-1" }),
          title: "Readme",
          url: "https://example.test/readme",
        },
      },
    ], "tab-1");

    const markup = renderToStaticMarkup(
      <WebuiPortSlicesProvider slices={createWebuiPortSlices({})}>
        <WebuiWorkspaceTabStrip state={state} dispatch={() => undefined} />
      </WebuiPortSlicesProvider>,
    );

    // The page's title is the runtime's; the strip never fetches a favicon.
    expect(markup).toContain("Readme");
    // A web tab carries the default glyph — a dot — not an icon, and certainly
    // no `<img>` of any kind.
    expect(markup).toContain("webui-workspace-web-glyph");
    expect(markup).not.toContain("<img");
  });

  it("owns the close button and the new tab affordance", () => {
    const state = stateWithTabs([
      { id: "tab-1", content: { kind: "files", sessionId: "session-1", workspaceDir: "/work" } },
    ], "tab-1");

    const markup = renderToStaticMarkup(
      <WebuiPortSlicesProvider slices={createWebuiPortSlices({})}>
        <WebuiWorkspaceTabStrip state={state} dispatch={() => undefined} />
      </WebuiPortSlicesProvider>,
    );

    expect(markup).toContain('data-testid="workspace-tab-tab-1-close"');
    expect(markup).toContain('data-testid="workspace-add-tab"');
  });

  it("opens the new tab page when the affordance fires, and opens a fresh one every time", () => {
    // The launcher is a tab's content rather than a singleton the panel keeps:
    // a person who typed a url into the last new tab page wants another one, and
    // the page they opened must still be there beside it.
    const starting = stateWithTabs([], undefined);
    const first = reduceWorkspacePanelState(starting, { type: "open-new-tab" });
    const second = reduceWorkspacePanelState(first, { type: "open-new-tab" });
    expect(first.tabs).toHaveLength(1);
    expect(first.tabs[0]?.content.kind).toBe("launcher");
    expect(first.activeTabId).toBe(first.tabs[0]?.id);
    expect(second.tabs).toHaveLength(2);
    expect(new Set(second.tabs.map((tab) => tab.id)).size).toBe(2);
    expect(second.tabs.filter((tab) => tab.content.kind === "launcher")).toHaveLength(2);
    expect(second.activeTabId).toBe(second.tabs[1]?.id);
  });

  it("turns each published web tab into a panel tab through the existing open-web-tab command", () => {
    // The strip subscribes to `watchBrowserWebTabs`; when a snapshot lands it
    // dispatches an `open-web-tab` for every published target the reducer does
    // not already know about. The reducer's own rule (issue #206) keeps
    // duplicates out — the strip does not keep its own list.
    const commands = webuiWorkspaceTabStripReconcile([], {
      surface: "isolated-chromium",
      tabs: [
        webTab({ target: target({ browserId: "browser-2", targetId: "tab-1" }), title: "First" }),
        webTab({ target: target({ browserId: "browser-2", targetId: "tab-2" }), title: "Second" }),
      ],
    });

    expect(commands.map((entry) => entry.command)).toEqual([
      {
        type: "open-web-tab",
        target: target({ browserId: "browser-2", targetId: "tab-1" }),
        title: "First",
        url: "https://example.test/",
      },
      {
        type: "open-web-tab",
        target: target({ browserId: "browser-2", targetId: "tab-2" }),
        title: "Second",
        url: "https://example.test/",
      },
    ]);
  });

  it("dispatches when the page behind a web tab moved", () => {
    // A web tab shows the page's title, and the title moves when the page
    // navigates. The snapshot is how the panel hears about it.
    const existing: WorkspacePanelState["tabs"] = [
      {
        id: "tab-1",
        content: {
          kind: "web",
          target: target({ browserId: "browser-2", targetId: "tab-1" }),
          title: "First",
          url: "https://example.test/",
        },
      },
    ];

    const commands = webuiWorkspaceTabStripReconcile(existing, {
      surface: "isolated-chromium",
      tabs: [
        webTab({ target: target({ browserId: "browser-2", targetId: "tab-1" }), title: "Second" }),
      ],
    });

    expect(commands).toHaveLength(1);
    expect(commands[0]?.command).toMatchObject({ type: "open-web-tab", title: "Second" });
  });

  it("does not dispatch when the snapshot's tabs are already panel tabs", () => {
    // A snapshot that lands twice changes nothing: the strip's "for each
    // unknown target, dispatch" rule keeps the existing web tabs where they
    // are, so a re-publish is a no-op.
    const existing: WorkspacePanelState["tabs"] = [
      {
        id: "tab-1",
        content: {
          kind: "web",
          target: target({ browserId: "browser-2", targetId: "tab-1" }),
          title: "First",
          url: "https://example.test/",
        },
      },
    ];

    const commands = webuiWorkspaceTabStripReconcile(existing, {
      surface: "isolated-chromium",
      tabs: [webTab({ target: target({ browserId: "browser-2", targetId: "tab-1" }), title: "First" })],
    });

    expect(commands).toHaveLength(0);
  });
});

describe("the new tab page", () => {
  it("is four tiles and one URL box, and no browser tool view among them", () => {
    const markup = renderLauncher(launcherTab());

    // The add menu's four entries became the launcher's tiles, and the browser
    // tool tab that used to lead that menu is gone.
    for (const kind of ["review", "terminal", "canvas", "files"]) {
      expect(markup).toContain(`data-testid="workspace-launcher-tile-${kind}"`);
    }
    expect(markup).toContain('data-testid="workspace-launcher-brand"');
    expect(markup).toContain('data-testid="workspace-launcher-url"');
    // Exactly one text input: the URL box. The launcher has no second place to
    // type a url.
    expect(markup.match(/<input/g)).toHaveLength(1);
  });

  it("renders nothing for a tab that is not showing the new tab page", () => {
    const markup = renderLauncher({
      id: "tab-1",
      content: {
        kind: "web",
        target: target({ browserId: "browser-2", targetId: "tab-1" }),
        title: "Example",
        url: "https://example.test/",
      },
    });

    expect(markup).toBe("");
  });

  it("opens each tile in the tab the tile is on", () => {
    // A tile replaces the launcher's content; it does not activate somebody
    // else's tab and leave a launcher behind. Every tile names the tab it is
    // rendered on, which is the whole difference between the launcher and the
    // menu it replaced.
    for (const tile of webuiWorkspaceLauncherTiles()) {
      expect(webuiWorkspaceLauncherTileCommand(tile, "tab-3", {
        sessionId: "session-1",
        workspaceDir: "/work",
      })).toMatchObject({ tabId: "tab-3" });
    }
    expect(
      webuiWorkspaceLauncherTileCommand(
        webuiWorkspaceLauncherTiles()[0]!,
        "tab-3",
        { sessionId: "session-1", workspaceDir: "/work" },
      ),
    ).toEqual({
      type: "open-workspace-review",
      sessionId: "session-1",
      workspaceDir: "/work",
      tabId: "tab-3",
    });
  });

  it("leaves the changes tile out when it has no session and workspace to show", () => {
    // The tile's requirements are the ones it had as a menu entry; without them
    // it has nothing to open, so it is not rendered rather than rendered dead.
    expect(
      webuiWorkspaceLauncherTileCommand(
        webuiWorkspaceLauncherTiles()[0]!,
        "tab-3",
        { sessionId: "session-1" },
      ),
    ).toBeUndefined();
    const markup = renderToStaticMarkup(
      <WebuiPortSlicesProvider slices={createWebuiPortSlices({})}>
        <WebuiWorkspaceLauncher tab={launcherTab()} dispatch={() => undefined} />
      </WebuiPortSlicesProvider>,
    );
    expect(markup).not.toContain('data-testid="workspace-launcher-tile-review"');
  });

  it("opens the url the person typed through the browser's port, and binds the page to that tab", async () => {
    // The launcher's URL box calls the browser business's port — the same
    // `open_tab` the Agent's tools perform — and the answer names the page, which
    // is what this tab is bound to. The request is dispatched first so a
    // snapshot that lands mid-call finds the tab that asked.
    const asked: { url: string }[] = [];
    const dispatched: WorkspacePanelCommand[] = [];

    await webuiWorkspaceLauncherOpenPage({
      tabId: "tab-9",
      url: "https://example.test",
      dispatch: (command) => dispatched.push(command),
      open: async (request) => {
        asked.push(request);
        return { target: target({ browserId: "browser-2", targetId: "tab-1" }) };
      },
    });

    expect(asked).toEqual([{ url: "https://example.test" }]);
    expect(dispatched).toEqual([
      { type: "request-web-page", tabId: "tab-9", url: "https://example.test" },
      {
        type: "open-web-tab",
        target: target({ browserId: "browser-2", targetId: "tab-1" }),
        title: "",
        url: "https://example.test",
        tabId: "tab-9",
      },
    ]);
  });

  it("reports the runtime's own refusal rather than swallowing it", async () => {
    // The refusal is the one the Agent's `open_tab` gets for the same switch,
    // carried by the same message: the launcher does not get a browser of its
    // own, so it does not get its own wording either.
    const dispatched: WorkspacePanelCommand[] = [];
    await webuiWorkspaceLauncherOpenPage({
      tabId: "tab-9",
      url: "https://example.test",
      dispatch: (command) => dispatched.push(command),
      open: async () => {
        const refusal = new Error('Browser surface "isolated-chromium" is not authorized.');
        throw Object.assign(refusal, { code: "browser_surface_not_authorized" });
      },
    });

    expect(dispatched[1]).toEqual({
      type: "request-web-page",
      tabId: "tab-9",
      url: "https://example.test",
      error: 'Browser surface "isolated-chromium" is not authorized.',
    });
  });

  it("offers the URL box only when the host wired a browser to call", () => {
    const wired = renderLauncher(launcherTab(), {
      openBrowserWebTab: async () => ({ accepted: true, target: target() }),
    });
    expect(wired).not.toContain("disabled");
    expect(wired).toContain("打开网页");

    const markup = renderLauncher(launcherTab());
    expect(markup).toContain('data-testid="workspace-launcher-url-submit"');
    expect(markup).toContain("disabled");
    expect(markup).toContain("无法打开网页");
  });

  it("passes a bare host to the browser as a url it can open", () => {
    // The launcher hands the browser its own address form: a bare host is a
    // web address, and the browser's normalisation is what says which one it
    // is. A host with no path keeps the browser's own trailing slash.
    expect(webuiWorkspaceLauncherUrl("example.test")).toBe("https://example.test/");
    expect(webuiWorkspaceLauncherUrl("  example.test/a  ")).toBe("https://example.test/a");
    expect(webuiWorkspaceLauncherUrl("http://example.test/a")).toBe("http://example.test/a");
    // A host with a port is a host, not a scheme.
    expect(webuiWorkspaceLauncherUrl("localhost:3000")).toBe("https://localhost:3000/");
    // An empty box opens nothing rather than opening a blank page.
    expect(webuiWorkspaceLauncherUrl("   ")).toBe("");
  });

  it("keeps the url box while the runtime is asked, and says why when it refuses", () => {
    // A refusal is not a closed tab: the launcher is still a launcher, the
    // person can type something else, and the reason comes from the runtime —
    // the same refusal the Agent's `open_tab` gets.
    const refused = reduceWorkspacePanelState(stateWithTabs([launcherTab()], "tab-9"), {
      type: "request-web-page",
      tabId: "tab-9",
      url: "https://example.test",
      error: 'Browser surface "isolated-chromium" is not authorized.',
    });
    expect(refused.tabs[0]?.content).toEqual({
      kind: "launcher",
      request: {
        url: "https://example.test",
        error: 'Browser surface "isolated-chromium" is not authorized.',
      },
    });

    const markup = renderLauncher(refused.tabs[0]!);
    expect(markup).toContain('data-testid="workspace-launcher-url"');
    expect(markup).toContain('data-testid="workspace-launcher-error"');
    expect(markup).toContain("is not authorized");
  });
});

describe("a page typed in the launcher lands in the tab that asked for it", () => {
  const requested = reduceWorkspacePanelState(stateWithTabs([launcherTab()], "tab-9"), {
    type: "request-web-page",
    tabId: "tab-9",
    url: "https://example.test",
  });
  const answer = {
    type: "open-web-tab",
    target: target({ browserId: "browser-2", targetId: "tab-1" }),
    title: "",
    url: "https://example.test",
  } as const;

  it("binds the page to the launcher that asked when the answer lands first", () => {
    const after = reduceWorkspacePanelState(requested, { ...answer, tabId: "tab-9" });
    expect(after.tabs).toHaveLength(1);
    expect(after.tabs[0]?.id).toBe("tab-9");
    expect(after.tabs[0]?.content).toMatchObject({ kind: "web" });
    expect(after.activeTabId).toBe("tab-9");
  });

  it("binds it to the same tab when the runtime's snapshot lands first", () => {
    // The snapshot names no tab, and the port's answer names one. The two race,
    // so the launcher that is waiting for a page is the tab the snapshot's page
    // belongs to — one page, one tab, whichever arrives first.
    const after = reduceWorkspacePanelState(requested, answer);
    expect(after.tabs).toHaveLength(1);
    expect(after.tabs[0]?.id).toBe("tab-9");
    expect(after.tabs[0]?.content).toMatchObject({ kind: "web" });
  });

  it("leaves the tab alone when the person has looked somewhere else", () => {
    const state = reduceWorkspacePanelState(
      stateWithTabs([launcherTab(), { id: "tab-2", content: { kind: "files" } }], "tab-2"),
      { type: "request-web-page", tabId: "tab-9", url: "https://example.test" },
    );
    const after = reduceWorkspacePanelState(state, { ...answer, tabId: "tab-9" });
    expect(after.activeTabId).toBe("tab-2");
    expect(after.tabs.find((tab) => tab.id === "tab-9")?.content).toMatchObject({ kind: "web" });
  });

  it("opens a tab of its own for a page nothing asked for", () => {
    // That is the Agent's page: no launcher is waiting for it, so it opens a tab
    // and becomes the active one.
    const after = reduceWorkspacePanelState(stateWithTabs([launcherTab()], "tab-9"), answer);
    expect(after.tabs).toHaveLength(2);
    expect(after.tabs[1]?.content).toMatchObject({ kind: "web" });
    expect(after.activeTabId).toBe(after.tabs[1]?.id);
  });

  it("replaces the launcher's content in place when a tile is chosen", () => {
    const after = reduceWorkspacePanelState(stateWithTabs([launcherTab()], "tab-9"), {
      type: "open-tab",
      kind: "terminal",
      sessionId: "session-1",
      workspaceDir: "/work",
      tabId: "tab-9",
    });
    expect(after.tabs).toHaveLength(1);
    expect(after.tabs[0]?.id).toBe("tab-9");
    expect(after.tabs[0]?.content).toMatchObject({ kind: "terminal" });
  });

  it("opens a tile in its own tab when the panel already shows one", () => {
    // A tile opens what it names in the tab it is on. The singleton rule still
    // holds for every other caller — it is only the launcher that names a tab.
    const opened = reduceWorkspacePanelState(stateWithTabs([], undefined), {
      type: "open-tab",
      kind: "terminal",
      sessionId: "session-1",
      workspaceDir: "/work",
    });
    const after = reduceWorkspacePanelState(opened, {
      type: "open-tab",
      kind: "terminal",
      sessionId: "session-1",
      workspaceDir: "/work",
      tabId: "tab-9",
    });
    expect(after.tabs).toHaveLength(1);
    expect(after.tabs[0]?.content).toMatchObject({ kind: "terminal" });
  });
});
