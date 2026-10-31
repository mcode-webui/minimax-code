// The rail context menu's single registry.
//
// The rule is which items the menu offers, in what order, with which label, and
// for which subject; it used to live in `openSessionMenu`'s two tables and
// `openProjectMenu`'s one. It now lives in `projection/rail-menu.ts`, and the host
// maps a declared key to its icon and its wiring through one branch.
//
// **A second renderer cannot enumerate independently** — the claim is not that
// adding an item becomes a one-line edit, since a registry may carry a host render
// branch. So this file asserts both halves of "cannot": no label appears outside
// the registry, and the host's wired keys are exactly the declared ones — a key
// wired without a declaration fails, and a declared key nothing wires fails.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

import {
  WEBUI_RAIL_MENU,
  webuiRailMenuFor,
  webuiRailMenuKeys,
  type WebuiRailMenuState,
} from "../../src/client/features/sessions/projection/rail-menu.js";

const RAIL = new URL("../../src/client/features/sessions/ui/SessionRail.tsx", import.meta.url);
const rail = readFileSync(RAIL, "utf8");
const flat = (text: string): string => text.replace(/\s+/gu, " ");

const state = (over: Partial<WebuiRailMenuState> = {}): WebuiRailMenuState => ({
  pinned: false,
  archived: false,
  ...over,
});

describe("the rail menu is declared once", () => {
  it("resolves a label for every item and none for a divider", () => {
    for (const entries of Object.values(WEBUI_RAIL_MENU)) {
      for (const entry of entries) {
        if (entry.kind === "divider") expect(entry.label).toBeUndefined();
        else {
          const resolved = webuiRailMenuFor("session", state()).find((e) => e.key === entry.key)
            ?.label ?? entry.label;
          expect(typeof resolved === "function" ? resolved(state()) : resolved).toBeTruthy();
        }
      }
    }
  });

  it("gives each subject's menu unique keys, and shares a key only on purpose", () => {
    // Uniqueness is per subject — a rendered menu's React keys — not across
    // subjects: `rename`, `export` and `delete` deliberately name the same
    // wiring for a session and for a child session, which is why one host branch
    // serves both menus.
    for (const subject of ["session", "child-session", "project"] as const) {
      const keys: string[] = [];
      for (const entry of webuiRailMenuFor(subject, state())) {
        for (const nested of entry.submenu ?? [entry]) keys.push(nested.key);
      }
      expect(new Set(keys).size).toBe(keys.length);
    }
    const keysOf = (subject: "session" | "child-session" | "project"): string[] =>
      webuiRailMenuFor(subject, state()).flatMap((entry) =>
        (entry.submenu ?? [entry]).map((nested) => nested.key),
      );
    const child = new Set(keysOf("child-session"));
    // `copy-session-id` is nested inside `session`'s `copy` submenu and top-level
    // for a child session; the other three are top-level in both.
    expect(keysOf("session").filter((key) => child.has(key)).sort()).toEqual([
      "copy-session-id",
      "delete",
      "export",
      "rename",
    ]);
  });

  it("keeps session pinning on the row toggle and labels remaining stateful actions", () => {
    const labels = (subject: "session" | "project", s: WebuiRailMenuState): string[] =>
      webuiRailMenuFor(subject, s).map((entry) =>
        typeof entry.label === "string" ? entry.label : String(entry.label?.(s)),
      );
    expect(labels("session", state({ pinned: true }))).not.toContain("取消置顶");
    expect(labels("session", state())).not.toContain("置顶");
    expect(labels("session", state({ archived: true }))).toContain("取消归档");
    expect(labels("project", state({ pinned: true }))).toContain("取消置顶项目");
  });

  it("keeps the render order the two builders had", () => {
    expect(webuiRailMenuFor("session", state()).map((entry) => entry.key)).toEqual([
      "rename",
      "archive",
      "fork-divider",
      "fork-current",
      "fork-worktree",
      "copy-divider",
      "show-folder",
      "copy",
      "export",
      "feedback",
      "delete-divider",
      "delete",
    ]);
    expect(webuiRailMenuFor("child-session", state()).map((entry) => entry.key)).toEqual([
      "rename",
      "export",
      "copy-session-id",
      "delete",
    ]);
    expect(webuiRailMenuFor("project", state()).map((entry) => entry.key)).toEqual([
      "rename-project",
      "toggle-pin-project",
      "show-project-in-folder",
      "archive-project-sessions",
      "remove-project",
    ]);
  });
});

describe("no second renderer can enumerate independently", () => {
  it("keeps every label out of the component layer", () => {
    // The labels come from the registry, so the component must not hold one. A
    // second builder with its own copy fails here.
    const labels = webuiRailMenuKeys().flatMap((key) => {
      const entry = [...WEBUI_RAIL_MENU.session, ...WEBUI_RAIL_MENU.project].find(
        (candidate) => candidate.key === key,
      );
      if (!entry) return [];
      const resolved = typeof entry.label === "function" ? entry.label(state()) : entry.label;
      return resolved ? [resolved] : [];
    });
    expect(labels.length).toBeGreaterThan(8);
    for (const label of labels) {
      expect(flat(rail)).not.toContain(`label: "${label}"`);
    }
    // ...and it does read the registry rather than holding its own table.
    expect(flat(rail)).toContain("webuiRailMenuFor(");
  });

  it("wires exactly the declared keys, both directions", () => {
    // The host branch is a permitted exception; what it may not do is cover a key
    // the registry does not declare, or leave a declared key unwired.
    const wiring = rail.slice(rail.indexOf("const railMenuWiring"), rail.indexOf("const buildRailMenu"));
    const wired = [...wiring.matchAll(/^\s{4}(?:"([a-z-]+)"|([a-z]+)): \{/gmu)].map(
      (match) => match[1] ?? match[2],
    );
    expect([...wired].sort()).toEqual([...webuiRailMenuKeys()].sort());
  });
});
