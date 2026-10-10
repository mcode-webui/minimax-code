import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { WebuiIconContextPin } from "../../src/client/icons.js";
import { WebuiProjectList } from "../../src/client/components/SessionRail.js";
import type { WebuiClientProject, WebuiClientSession, WebuiClientSessionPage } from "../../src/client/contracts/session-view.js";

/**
 * Pin affordance: the two things a pinned row has to be able to say.
 *
 *  1. The action button draws the ACTION, not the state. Already pinned means
 *     the click unpins, so the glyph is the slashed pin -- the same glyph the
 *     context menu already uses (`WebuiIconContextPin pinned`).
 *  2. The row says so while you are NOT hovering. Pinned rows sort to the top,
 *     which is a fact about order, not about the row, and it is gone the moment
 *     a second session outranks the first.
 *
 * Both are asserted against rendered markup, not source text. That matters for
 * the second one: `renderToStaticMarkup` produces markup with no hover state at
 * all, so "the marker is in the markup" and "the marker is always visible" are
 * the same claim here. A source-level assertion could not tell them apart.
 */

function session(
  sessionId: string,
  over: Partial<WebuiClientSession> = {},
): WebuiClientSession {
  return { sessionId, agentName: "main", createdAt: 0, updatedAt: 1, ...over };
}

const WORKSPACE = "/w/one";

function project(over: Partial<WebuiClientProject> = {}): WebuiClientProject {
  return {
    projectId: 1,
    projectKind: "workspace",
    workspaceDir: WORKSPACE,
    pinned: false,
    hidden: false,
    orderIndex: 0,
    recentAtMs: 1_700_000_000_000,
    latestActivityAtMs: 1_700_000_000_000,
    sessionCount: 2,
    ...over,
  } as WebuiClientProject;
}

const PAGE: WebuiClientSessionPage = {
  sessions: [session("mvs_pinned", { workspaceDir: WORKSPACE }), session("mvs_plain", { workspaceDir: WORKSPACE })],
  hasMore: false,
};

const NOW = 1_000_000;

const renderProjectList = (over: Record<string, unknown> = {}): string =>
  renderToStaticMarkup(
    createElement(WebuiProjectList, {
      page: PAGE,
      projectRecords: [project()],
      loading: false,
      // A clock by default, so the row's meta block actually renders. Without
      // it the block bails out, and every "this row has no pin mark" assertion
      // below would be satisfied by the block being absent -- a test that
      // cannot fail no matter what the rail draws.
      now: NOW,
      // Without a handler the row draws no pin button at all, so the button
      // tests below have nothing to read. The handler is a no-op: static
      // markup never clicks anything.
      onToggleSessionPin: () => {},
      ...over,
    }),
  );

/** The markup of one session row, from its link to the end of its list item. */
function rowSlice(html: string, sessionId: string): string {
  const at = html.indexOf(`data-webui-session-link="${sessionId}"`);
  if (at < 0) return "";
  const end = html.indexOf("</li>", at);
  return html.slice(at, end < 0 ? html.length : end);
}

/**
 * The accessible name of the row's pin button.
 *
 * Read off the pin `<button>` element specifically. Two looser readings both
 * keep passing after the accessible name is broken, which is the one thing
 * this exists to catch: a substring search for 取消置顶 over the whole row is
 * satisfied by the button's `title`, and a search for any aria-label holding
 * 置顶 is satisfied by the standing pin mark's own 已置顶.
 */
function pinButtonLabel(html: string, sessionId: string): string | undefined {
  // The pin button is the first action in the row's hover strip.
  const button = rowSlice(html, sessionId).match(
    /<button[^>]*class="webui-rail-action"[^>]*>/u,
  )?.[0];
  return button?.match(/aria-label="([^"]*)"/u)?.[1];
}

/**
 * The pin glyphs the row's action button drew, as `pinned` / `unpinned`.
 *
 * Keyed on the clipPath's own `id`, not on every mention of the name: one
 * glyph mentions it twice (the `url(#...)` reference and the `<clipPath id>`),
 * so counting mentions counts each button twice and a test written that way
 * would pass on a row that drew nothing.
 */
function pinGlyphIn(html: string, sessionId: string): string[] {
  const ids = [
    ...rowSlice(html, sessionId).matchAll(/<clipPath id="webui-context-pin-(un)?pinned-[^"]*"/gu),
  ];
  return ids.map((m) => (m[1] ? "unpinned" : "pinned"));
}

describe("the pin action glyph", () => {
  it("draws different marks for the two states", () => {
    const pinned = renderToStaticMarkup(createElement(WebuiIconContextPin, { pinned: true }));
    const open = renderToStaticMarkup(createElement(WebuiIconContextPin, { pinned: false }));
    expect(pinned).not.toBe(open);
  });

  it("gives every instance its own clip path id", () => {
    // The slashed glyph is clipped to the viewBox, so it needs a clipPath.
    // A hardcoded id means the second pinned row on screen resolves its
    // clipPath against the first row's element -- correct only while the rail
    // shows at most one pinned row, which is never true.
    const html = renderToStaticMarkup(
      createElement(
        "div",
        null,
        createElement(WebuiIconContextPin, { pinned: true }),
        createElement(WebuiIconContextPin, { pinned: true }),
      ),
    );
    const ids = [...html.matchAll(/<clipPath id="([^"]+)"/gu)].map((m) => m[1]);
    expect(ids).toHaveLength(2);
    expect(new Set(ids).size, "duplicate clipPath id").toBe(2);
    for (const id of ids) {
      expect(html, `id ${id} is never referenced`).toContain(`url(#${id})`);
    }
  });
});

describe("the rail pin button", () => {
  it("offers the unpin glyph on a pinned row, not the pin glyph", () => {
    // The label already said 取消置顶 before this; only the drawing was missing,
    // which is what left the button looking identical in both states.
    const html = renderProjectList({ pinnedSessions: { mvs_pinned: true } });
    expect(pinGlyphIn(html, "mvs_pinned")).toEqual(["pinned"]);
  });

  it("offers the pin glyph on a row that is not pinned", () => {
    const html = renderProjectList({ pinnedSessions: { mvs_pinned: true } });
    expect(pinGlyphIn(html, "mvs_plain")).toEqual(["unpinned"]);
  });

  it("agrees with its own label in both directions", () => {
    // Guards the pair rather than either half: a future edit that rewires the
    // label but leaves the glyph pinned (or the reverse) is the regression this
    // whole change exists to prevent. Exact match on the accessible name, so
    // that fixing one half and leaving the other is visible.
    const html = renderProjectList({ pinnedSessions: { mvs_pinned: true } });
    expect(pinButtonLabel(html, "mvs_pinned")).toBe("取消置顶：main");
    expect(pinButtonLabel(html, "mvs_plain")).toBe("置顶：main");
  });

  it("states the action, not the state, in the label", () => {
    // The button that offers the unpin glyph is labelled 取消置顶, and the one
    // offering the pin glyph is labelled 置顶. Asserted as a cross-check rather
    // than by re-deriving from the same flag, so a single change that flips the
    // flag's meaning cannot quietly make both halves agree on the wrong thing.
    const html = renderProjectList({ pinnedSessions: { mvs_pinned: true } });
    const glyphOfPinned = pinGlyphIn(html, "mvs_pinned")[0];
    const labelOfPinned = pinButtonLabel(html, "mvs_pinned");
    expect(glyphOfPinned === "pinned").toBe(labelOfPinned?.startsWith("取消置顶"));
  });

  it("does not leak one row's state onto another", () => {
    // A `pinned` flag read from the wrong record -- the project, the first row,
    // a stale closure -- lights up every row at once. This is the failure that
    // reads as "the rail is just like that".
    const html = renderProjectList({ pinnedSessions: { mvs_pinned: true } });
    expect(pinGlyphIn(html, "mvs_pinned")).toHaveLength(1);
    expect(pinGlyphIn(html, "mvs_plain")).toHaveLength(1);
    expect(pinGlyphIn(html, "mvs_pinned")[0]).toBe("pinned");
    expect(pinGlyphIn(html, "mvs_plain")[0]).toBe("unpinned");
  });

  it("gives the two rows different clip paths", () => {
    // Follows from the ids being per-instance, and is the observable form of
    // the bug: a shared id would make row two's slash clip against row one's
    // element, which is invisible in a screenshot and obvious in the DOM.
    const html = renderProjectList({ pinnedSessions: { mvs_pinned: true } });
    const ids = [...html.matchAll(/<clipPath id="(webui-context-pin-[^"]+)"/gu)].map((m) => m[1]);
    expect(ids).toHaveLength(2);
    expect(new Set(ids).size).toBe(2);
  });
});

describe("the persistent pin marker", () => {
  const MARK = 'data-webui-pin-mark="true"';

  it("marks a pinned row in markup that has no hover state at all", () => {
    const html = renderProjectList({ pinnedSessions: { mvs_pinned: true } });
    expect(html).toContain(MARK);
  });

  it("does not mark a row that is not pinned", () => {
    // Rendered with the clock on, so the meta block exists on BOTH rows. A
    // version of this that ran without one would pass on a rail that marks
    // every row, because no row would have a meta block to mark.
    const html = renderProjectList({ pinnedSessions: { mvs_pinned: true } });
    expect(html, "the meta block must exist for this to mean anything").toMatch(
      /webui-rail-session-meta/gu,
    );
    const start = html.indexOf('data-webui-session-link="mvs_plain"');
    const end = html.indexOf("</li>", start);
    expect(html.slice(start, end)).not.toContain(MARK);
  });

  it("survives a host with no activity map and no clock", () => {
    // The trap. The meta block bails out early when it has neither an activity
    // map nor a clock, which is exactly the shape the rail is rendered in
    // outside the app (SSR fixtures, and any host that does not subscribe).
    // A pinned row there would silently lose its marker -- the one case where
    // the user most needs to know the row is pinned, because there is no
    // running/unread signal to read it against.
    const html = renderProjectList({
      pinnedSessions: { mvs_pinned: true },
      activity: undefined,
      now: undefined,
    });
    expect(html).toContain(MARK);
  });

  it("still renders nothing at all for a host with no clock, no activity and no pins", () => {
    // The other half of the same guard: widening the early return must not
    // leave an empty meta element behind on every row, which is what keeps the
    // existing snapshots byte-identical.
    const html = renderProjectList({
      pinnedSessions: undefined,
      activity: undefined,
      now: undefined,
    });
    expect(html).not.toContain(MARK);
    expect(html).not.toContain("webui-rail-session-meta");
  });

  it("sits outside the hover-only action strip", () => {
    // `.webui-session-row-actions` is `opacity: 0` until the row is hovered or
    // focused. A marker rendered inside it is not persistent, it is a second
    // hover affordance wearing a different hat.
    const html = renderProjectList({ pinnedSessions: { mvs_pinned: true } });
    const strip = html.match(/<div class="webui-session-row-actions">[\s\S]*?<\/div>/gu) ?? [];
    expect(strip.length).toBeGreaterThan(0);
    for (const chunk of strip) {
      expect(chunk, "marker rendered inside the hover-only strip").not.toContain(MARK);
    }
  });

  it("marks pinned rows in every row shape, not just the first one", () => {
    // Shape one: a project session row. Straightforward, and the clock in the
    // shared helper is what makes the meta block render at all.
    const html = renderProjectList({ pinnedSessions: { mvs_pinned: true } });
    const at = html.indexOf('data-webui-session-link="mvs_pinned"');
    expect(at, "the project session row must render").toBeGreaterThanOrEqual(0);
    expect(html.slice(at, html.indexOf("</li>", at))).toContain(MARK);
  });

  it("wires the pinned flag into the child row's meta call", () => {
    // Shape two: a child session row, asserted against the source rather than
    // against markup, and the reason is structural rather than convenience.
    //
    // Child rows render only when `childrenExpanded` is set, and that is
    // internal `useState` with no prop to seed it -- a disclosure button owns
    // it. This suite is `environment: "node"` and `renderToStaticMarkup` does
    // not run effects, so there is no way to click the disclosure and no way
    // to inject the state. Any markup assertion here would be asserting on an
    // empty slice.
    //
    // The window is anchored on `session={child}` and has to contain the whole
    // prop list, so this can fail: revert the child call site to the
    // three-prop form and the flag is outside the window.
    const source = readFileSync(
      new URL("../../src/client/components/SessionRail.tsx", import.meta.url),
      "utf8",
    );
    const anchor = source.indexOf("session={child}");
    expect(anchor, "the child row's meta call is gone entirely").toBeGreaterThanOrEqual(0);
    const window = source.slice(anchor, anchor + 400);
    expect(window).toContain("pinned={Boolean(pinnedSessions?.[child.sessionId])}");
  });

  it("marks pinned rows in the flat list the running and unread views render", () => {
    // A separate component with its own copy of the row. Asserted through
    // WebuiProjectList on purpose: rendering WebuiSessionList directly would
    // pass even with the passthrough from the project list deleted, which is
    // the wiring that actually ships.
    const pinnedSession = session("mvs_busy", { workspaceDir: WORKSPACE });
    const html = renderProjectList({
      page: { sessions: [pinnedSession], hasMore: false },
      view: "running",
      activity: { mvs_busy: { lastActivityAt: NOW, busy: { turnId: "t1", busyReason: "turn" } } },
      pinnedSessions: { mvs_busy: true },
    });
    expect(html).toContain('data-webui-rail-view-active="running"');
    const at = html.indexOf('data-webui-session-link="mvs_busy"');
    expect(at, "the running view must list the session").toBeGreaterThanOrEqual(0);
    const end = html.indexOf("</li>", at);
    expect(html.slice(at, end)).toContain(MARK);
  });

  it("puts a drawn glyph inside the mark, not just a hook", () => {
    // An empty wrapper carrying `data-webui-pin-mark` satisfies every assertion
    // above: the row claims to be pinned and the screen shows nothing. The
    // attribute is a hook for CSS and for tests, and neither one draws.
    const html = renderProjectList({ pinnedSessions: { mvs_pinned: true } });
    const mark = html.match(/<span class="webui-rail-pin-mark"[^>]*>([\s\S]*?)<\/span>/u);
    expect(mark, "the mark wrapper is missing").not.toBeNull();
    const inner = mark?.[1] ?? "";
    expect(inner, "the mark draws nothing").toMatch(/<svg[\s\S]*?<path/u);
    // `currentColor` rather than a literal: the mark inherits its colour from
    // the meta block, and a hardcoded fill would ignore that.
    expect(inner).toContain('fill="currentColor"');
  });

  it("puts a drawn glyph inside the project mark too", () => {
    const html = renderProjectList({ pinnedProjects: { [WORKSPACE]: true } });
    const mark = html.match(
      /<span class="webui-project-pin-mark"[^>]*>([\s\S]*?)<\/span>/u,
    );
    expect(mark, "the project mark wrapper is missing").not.toBeNull();
    expect(mark?.[1] ?? "").toMatch(/<svg[\s\S]*?<path/u);
  });

  it("marks a pinned project, which otherwise only shows it through its sort position", () => {
    const html = renderProjectList({ pinnedProjects: { [WORKSPACE]: true } });
    expect(html).toContain('data-webui-project-pin-mark="true"');
  });

  it("does not mark a project that is not pinned", () => {
    const html = renderProjectList({ pinnedProjects: { [WORKSPACE]: false } });
    expect(html).not.toContain('data-webui-project-pin-mark="true"');
  });
});
