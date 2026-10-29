// The tab-kind registry.
//
// The right-column tab kinds were enumerated in **three** places — the union in
// `workspace-panel-state.ts`, the label map in `WorkspacePanels.tsx`, and the
// launcher's four tiles — so a new kind meant finding all three, and the type
// system caught only two of them. The registry has to exist and be the thing the
// host reads, **and a passing prohibition test does not discharge that**.
//
// The acceptance is that **a rule added to a second enumeration site fails the
// suite**. A registry may carry a host render branch, which is why the glyphs and
// the dispatch calls stay in the component: the assertions below target the words
// and the closed set, not the icons.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

import {
  WEBUI_WORKSPACE_LAUNCHER_TILE_ORDER,
  WEBUI_WORKSPACE_TAB_KINDS,
  webuiWorkspaceLauncherTiles,
  webuiWorkspaceTabLabel,
  type WebuiWorkspaceTabContent,
  type WebuiWorkspaceTabKind,
  type WorkspacePanelTab,
} from "../../src/client/features/workspace/projection/workspace-panel-state.js";

const CLIENT = new URL("../../src/client/", import.meta.url);
const read = (relative: string): string => readFileSync(new URL(relative, CLIENT), "utf8");
const flat = (text: string): string => text.replace(/\s+/gu, " ");

// Compile-time: a panel tab's content kind IS a declared kind, so the union is
// derived from the registry's shapes rather than listing the same names again.
type DerivedKindIsDeclared = WorkspacePanelTab["content"]["kind"] extends WebuiWorkspaceTabKind
  ? true
  : never;
const derived: DerivedKindIsDeclared = true;

const tab = (content: WebuiWorkspaceTabContent): WorkspacePanelTab => ({ id: "t", content });

describe("the kinds are declared once", () => {
  it("derives the panel's union from the registry", () => {
    expect(derived).toBe(true);
  });

  it("keeps the kind union literal out of every other module", () => {
    // The shape of the old third enumeration. Its absence is what "one registry"
    // means for the type half.
    expect(flat(read("features/workspace/ui/WorkspacePanels.tsx"))).not.toContain(
      '"files" | "canvas" | "terminal"',
    );
    expect(flat(read("features/workspace/projection/workspace-panel-state.ts"))).toContain(
      "export type WebuiWorkspaceTabContent",
    );
  });

  it("carries every kind the host can open, and no label of its own", () => {
    const workspaceUi = flat(read("features/workspace/ui/WorkspacePanels.tsx"))
      + flat(read("features/workspace/ui/WebuiWorkspaceTabStrip.public.tsx"));
    // The label map is gone; the words come from the registry.
    expect(workspaceUi).not.toContain('{ files: "查看文件"');
    // The strip is what carries the tab labels and the registry's render now:
    // the `webuiWorkspaceTabLabel(...)` reading lives in the strip's own file,
    // the only place the row's label is computed.
    expect(workspaceUi).toContain("webuiWorkspaceTabLabel(item)");
    // The launcher's tiles are built from the registry, never re-listed...
    expect(flat(read("features/workspace/ui/WebuiWorkspaceTabStrip.public.tsx"))).toContain(
      "webuiWorkspaceLauncherTiles()",
    );
    for (const tile of webuiWorkspaceLauncherTiles()) {
      expect(workspaceUi).not.toContain(`<span>${tile.label}</span>`);
    }
  });
});

describe("the registry answers for the whole closed set", () => {
  it("labels a tab by one rule", () => {
    expect(webuiWorkspaceTabLabel(tab({ kind: "terminal" }))).toBe("终端");
    expect(webuiWorkspaceTabLabel(tab({ kind: "files" }))).toBe("查看文件");
    expect(
      webuiWorkspaceTabLabel(
        tab({ kind: "file-preview", path: "src/client/main.tsx", sessionId: "s", workspaceDir: "/w" }),
      ),
    ).toBe("main.tsx");
    expect(
      webuiWorkspaceTabLabel(
        tab({ kind: "review", source: "workspace", sessionId: "s", workspaceDir: "/w" }),
      ),
    ).toBe("变更");
    expect(
      webuiWorkspaceTabLabel(
        tab({ kind: "review", source: "turn", sessionId: "s", workspaceDir: "/w", messageId: "m", files: [] }),
      ),
    ).toBe("Review");
    // A web tab is titled by the page, and the page's title is the runtime's
    // to report.
    expect(
      webuiWorkspaceTabLabel(
        tab({
          kind: "web",
          target: { surface: "isolated-chromium", browserId: "b", targetId: "t", generation: 1 },
          title: "Example",
          url: "https://example.test/",
        }),
      ),
    ).toBe("Example");
  });

  it("offers the launcher's tiles in one order, and only where a tile exists", () => {
    const tiles = webuiWorkspaceLauncherTiles();
    expect(tiles.map((tile) => tile.kind)).toEqual([
      "review",
      "terminal",
      "canvas",
      "miniapp-picker",
      "files",
    ]);
    expect(tiles.map((tile) => tile.label)).toEqual([
      "变更",
      "终端",
      "画布",
      "应用",
      "查看文件",
    ]);
    expect(tiles.map((tile) => tile.opens)).toEqual([
      { type: "open-workspace-review" },
      { type: "open-tab", kind: "terminal" },
      { type: "open-tab", kind: "canvas" },
      // The Mini App tile opens the Mini App tool page: which Mini App a tab
      // shows is chosen from the runtime's listing, so this tile carries no
      // plugin id and the page it opens is the one the choice is made in.
      { type: "open-tab", kind: "miniapp-picker" },
      { type: "open-tab", kind: "files" },
    ]);
    // Every tile names a declared kind, and the order names each one once.
    for (const kind of WEBUI_WORKSPACE_LAUNCHER_TILE_ORDER) {
      expect(WEBUI_WORKSPACE_TAB_KINDS[kind]).toBeDefined();
    }
    expect(new Set(WEBUI_WORKSPACE_LAUNCHER_TILE_ORDER).size).toBe(
      WEBUI_WORKSPACE_LAUNCHER_TILE_ORDER.length,
    );
    // A file preview has no tile: it is opened by a path. A web tab has none
    // either: it is opened by typing a URL, or by the Agent.
    expect(WEBUI_WORKSPACE_TAB_KINDS["file-preview"].tile).toBeNull();
    expect(WEBUI_WORKSPACE_TAB_KINDS.web.tile).toBeNull();
    expect(tiles.some((tile) => tile.kind === "file-preview")).toBe(false);
    expect(tiles.some((tile) => tile.kind === "web")).toBe(false);
  });
});
