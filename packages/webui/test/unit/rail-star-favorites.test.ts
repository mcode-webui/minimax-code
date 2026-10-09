import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import {
  filterWebuiRailViewSessions,
  selectWebuiRailViewTabs,
  type WebuiRailView,
} from "../../src/client/rail-buckets.js";
import { WebuiIconSessionStar } from "../../src/client/icons.js";
import { WebuiProjectList } from "../../src/client/components/SessionRail.js";
import type { WebuiSessionActivityMap } from "../../src/client/session-activity.js";
import type { WebuiClientProject, WebuiClientSession } from "../../src/client/contracts/session-view.js";

/**
 * Favourites: the fourth rail view, and the star that feeds it.
 *
 * 收藏 is not a fourth *grouping* and not a fourth status. It is a set the
 * reader chose, and the reason it earns a tab rather than living in the search
 * box is that it survives the page: a search box is emptied by the next
 * question, a star is not.
 *
 * Unlike pin, the star's glyph shows *state* and not the action. The slashed
 * pin reads as "unpin" because that is what the whole icon vocabulary does with
 * a slash; nobody reads a filled star as "remove", and Gmail, Mail and Notion
 * all use the same outline/filled pair. So the button is outline until starred
 * and yellow-filled after, and the two are not interchangeable the way the pin's
 * two are.
 *
 * The starred set is a required argument rather than an optional one. Optional
 * would typecheck at every call site that forgot it and quietly count zero,
 * which is the same shape of bug as a prop that is passed and then ignored.
 */

function session(
  sessionId: string,
  updatedAt: number,
  over: Partial<WebuiClientSession> = {},
): WebuiClientSession {
  return { sessionId, agentName: "main", createdAt: 0, updatedAt, ...over };
}

const WORKSPACE = "/w/one";
const NOW = 1_000_000;

const SESSIONS: readonly WebuiClientSession[] = [
  session("mvs_a", 1),
  session("mvs_b", 2),
  session("mvs_c", 3),
  session("mvs_d", 4),
  session("mvs_e", 5),
];

// Annotated, not inferred. Without it `busyReason: "turn"` widens to `string`
// and stops being assignable to `WebuiSessionActiveTurn["busyReason"]`, which
// is a union -- and nothing in this repo's tsc programs compiles test files, so
// the thirteen call sites below would hand a wrongly typed map to the filter
// and the suite would stay green on a fixture the product could never produce.
const ACTIVITY: WebuiSessionActivityMap = {
  mvs_a: { lastActivityAt: 5_000, busy: { turnId: "t1", busyReason: "turn" } },
  mvs_b: { lastActivityAt: 9_000, unread: 3 },
  mvs_c: { lastActivityAt: 7_000 },
};

const ids = (list: readonly WebuiClientSession[]): string[] =>
  list.map((entry) => entry.sessionId);

const tab = (view: WebuiRailView, starred: Readonly<Record<string, boolean>> = {}) =>
  selectWebuiRailViewTabs(SESSIONS, ACTIVITY, starred).find((entry) => entry.view === view);

describe("the favourites view", () => {
  it("is the fourth tab, after the three status views", () => {
    // Order is the contract: 项目 first because it is the view you land on, and
    // 收藏 last because it is the one you open on purpose.
    expect(selectWebuiRailViewTabs(SESSIONS, ACTIVITY, {}).map((entry) => entry.view)).toEqual([
      "projects",
      "running",
      "unread",
      "stars",
    ]);
  });

  it("is labelled 收藏 and says something true when it is empty", () => {
    const stars = tab("stars");
    expect(stars?.label).toBe("收藏");
    // "No sessions yet" is the same lie the other two status views avoid: there
    // are plenty of sessions, just none the reader starred.
    expect(stars?.emptyLabel).not.toBe("暂无会话");
  });

  it("lists exactly the starred sessions", () => {
    const starred = { mvs_c: true, mvs_e: true };
    expect(ids(filterWebuiRailViewSessions(SESSIONS, ACTIVITY, "stars", starred))).toEqual([
      "mvs_c",
      "mvs_e",
    ]);
  });

  it("counts the starred sessions in the page", () => {
    // From the page, not from the stored set: a star on a session that has been
    // archived or paged out would otherwise put a number on the tab that no row
    // accounts for.
    expect(tab("stars", { mvs_c: true, mvs_e: true })?.count).toBe(2);
    expect(tab("stars", { mvs_gone: true })?.count).toBe(0);
  });

  it("orders favourites by last activity, not by the page's order", () => {
    // The two orderings have to disagree or this proves nothing. The page is
    // ordered by `updatedAt`, so mvs_a (1) precedes mvs_b (2); the activity map
    // has b at 9_000 and a at 5_000, so activity order is the reverse. Deleting
    // the sort leaves [a, b] on screen and this goes red.
    expect(
      ids(filterWebuiRailViewSessions(SESSIONS, ACTIVITY, "stars", { mvs_a: true, mvs_b: true })),
    ).toEqual(["mvs_b", "mvs_a"]);
  });

  it("still orders by activity when the two orderings agree", () => {
    // The other direction, so a fix for the test above cannot be "always
    // reverse". mvs_c's record is newer than mvs_e's and its observed activity
    // is newer too, so both orderings put c first.
    expect(
      ids(filterWebuiRailViewSessions(SESSIONS, ACTIVITY, "stars", { mvs_c: true, mvs_e: true })),
    ).toEqual(["mvs_c", "mvs_e"]);
  });

  it("shows a starred session that has no activity entry at all", () => {
    // Starring is a decision the reader made, so it survives the runtime having
    // never told this client the session did anything. Gating on the activity
    // map would quietly drop it.
    expect(ids(filterWebuiRailViewSessions(SESSIONS, {}, "stars", { mvs_a: true }))).toEqual([
      "mvs_a",
    ]);
  });

  it("shows a starred session that is also running, without taking it out of running", () => {
    // Stars and running are orthogonal facts, not competing buckets. One view
    // is on screen at a time, so a session in both costs the reader nothing and
    // hiding it from either would be a lie.
    const starred = { mvs_a: true };
    expect(ids(filterWebuiRailViewSessions(SESSIONS, ACTIVITY, "stars", starred))).toEqual([
      "mvs_a",
    ]);
    expect(ids(filterWebuiRailViewSessions(SESSIONS, ACTIVITY, "running", starred))).toEqual([
      "mvs_a",
    ]);
  });

  it("leaves the other three views' counts alone when nothing is starred", () => {
    const before = selectWebuiRailViewTabs(SESSIONS, ACTIVITY, {});
    const after = selectWebuiRailViewTabs(SESSIONS, ACTIVITY, { mvs_a: true, mvs_b: true });
    for (const view of ["projects", "running", "unread"] as const) {
      expect(after.find((e) => e.view === view)?.count, view).toBe(
        before.find((e) => e.view === view)?.count,
      );
    }
  });

  it("returns an empty list rather than everything when nothing is starred", () => {
    // The dangerous failure is inverted: a filter that forgets its predicate
    // shows the whole rail under a tab labelled 收藏.
    expect(filterWebuiRailViewSessions(SESSIONS, ACTIVITY, "stars", {})).toEqual([]);
    expect(filterWebuiRailViewSessions(SESSIONS, ACTIVITY, "stars", undefined)).toEqual([]);
  });

  it("passes the project view through untouched", () => {
    expect(filterWebuiRailViewSessions(SESSIONS, ACTIVITY, "projects", { mvs_a: true })).toEqual(
      SESSIONS,
    );
  });

  it("never mutates the input array", () => {
    const input = [...SESSIONS];
    const before = ids(input);
    filterWebuiRailViewSessions(input, ACTIVITY, "stars", { mvs_b: true, mvs_c: true });
    expect(ids(input)).toEqual(before);
  });
});

describe("the star glyph", () => {
  const outline = renderToStaticMarkup(createElement(WebuiIconSessionStar, { starred: false }));
  const filled = renderToStaticMarkup(createElement(WebuiIconSessionStar, { starred: true }));

  /** The paint on the star's own path, not on the `svg` wrapper around it. */
  function pathFill(markup: string): string | undefined {
    return markup.match(/<path[^>]*\sfill="([^"]+)"/u)?.[1];
  }

  it("draws the two states differently", () => {
    expect(outline).not.toBe(filled);
  });

  it("is an outline until starred and a solid fill after", () => {
    // Asserted on the path's fill, not on the markup as a string. The root
    // `svg` carries `fill="none"` in this codebase's convention and a search
    // for it anywhere in the markup finds the wrapper, not the star -- which is
    // how a version of this test passed with both states drawn identically.
    expect(pathFill(outline)).toBe("none");
    expect(pathFill(filled)).toBe("currentColor");
  });

  it("strokes the outline so the star is not just an unfilled shape", () => {
    // `fill="none"` with no stroke renders nothing at all. This is the failure
    // that a fill-only assertion cannot see.
    expect(outline).toContain('stroke="currentColor"');
    expect(filled).not.toContain('stroke="currentColor"');
  });

  it("takes its colour from the caller, so the filled one can be yellow", () => {
    // `currentColor` rather than a literal: the yellow is a token, it flips with
    // the theme, and a hardcoded hex would be wrong in dark mode.
    expect(pathFill(filled)).toBe("currentColor");
  });

  it("is a five-pointed star in both states, not two different shapes", () => {
    const d = (markup: string) => markup.match(/\sd="([^"]+)"/u)?.[1];
    // Same outline in both states: the pair is a paint change, not a redraw. A
    // filled star drawn from different coordinates would be a different icon.
    expect(d(outline)).toBeDefined();
    expect(d(filled)).toBe(d(outline));
    // M + 9 L + Z: five points alternating with five notches.
    expect((d(filled)?.match(/L/gu) ?? []).length).toBe(9);
  });

  it("tags each state for the row and the stylesheet to key on", () => {
    expect(outline).toContain('data-webui-star="outline"');
    expect(filled).toContain('data-webui-star="filled"');
  });
});

describe("the star on a rail row", () => {
  const MARK = 'data-webui-star-mark="true"';

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

  const page = {
    sessions: [
      session("mvs_starred", 1, { workspaceDir: WORKSPACE }),
      session("mvs_plain", 2, { workspaceDir: WORKSPACE }),
    ],
    hasMore: false,
  };

  const render = (over: Record<string, unknown> = {}): string =>
    renderToStaticMarkup(
      createElement(WebuiProjectList, {
        page,
        projectRecords: [project()],
        loading: false,
        now: NOW,
        onToggleSessionPin: () => {},
        onToggleSessionStar: () => {},
        ...over,
      }),
    );

  function rowSlice(html: string, sessionId: string): string {
    const at = html.indexOf(`data-webui-session-link="${sessionId}"`);
    if (at < 0) return "";
    const end = html.indexOf("</li>", at);
    return html.slice(at, end < 0 ? html.length : end);
  }

  /** The row element, which holds the link and the hover-only action strip. */
  function rowOf(html: string, sessionId: string): string {
    // The strip is a sibling of the link, so slicing from the link alone never
    // reaches the buttons. Take from the row's opening div instead.
    const link = html.indexOf(`data-webui-session-link="${sessionId}"`);
    const rowStart = html.lastIndexOf('<div class="webui-project-session-row', link);
    const rowEnd = html.indexOf("</li>", link);
    return html.slice(rowStart < 0 ? link : rowStart, rowEnd < 0 ? html.length : rowEnd);
  }

  it("fills the star on a starred row and outlines it on the others", () => {
    const html = render({ starredSessions: { mvs_starred: true } });
    const kind = (id: string) => rowOf(html, id).match(/data-webui-star="(filled|outline)"/u)?.[1];
    expect(kind("mvs_starred")).toBe("filled");
    expect(kind("mvs_plain")).toBe("outline");
  });

  it("names the action on the button, and it follows the state", () => {
    const html = render({ starredSessions: { mvs_starred: true } });
    // Read off the star <button>, not off the row. A search for any aria-label
    // containing 收藏 finds the standing mark's own 已收藏 first, so this would
    // keep passing with the button's accessible name broken -- the same trap
    // the pin's label test fell into once.
    const label = (id: string) =>
      rowOf(html, id)
        .match(/<button[^>]*aria-label="([^"]*收藏[^"]*)"[^>]*>/u)?.[1];
    expect(label("mvs_starred")).toBe("取消收藏：main");
    expect(label("mvs_plain")).toBe("收藏：main");
  });

  it("offers a star button only when the host wires the action", () => {
    // No handler, no button -- the same rule the pin follows. A rail that drew
    // a dead star on every row would be a row of controls that do nothing.
    const html = render({ onToggleSessionStar: undefined });
    expect(rowOf(html, "mvs_plain")).not.toContain("data-webui-star=");
  });

  it("marks a starred row without it being hovered", () => {
    // The same standing-signal argument as the pin, and for the same reason: a
    // star the reader can only see by pointing at the row does not make the
    // favourites tab anything but a filter they have to go re-apply.
    const html = render({ starredSessions: { mvs_starred: true } });
    expect(rowSlice(html, "mvs_starred")).toContain(MARK);
    expect(rowSlice(html, "mvs_plain")).not.toContain(MARK);
  });

  it("survives a host with no activity map and no clock", () => {
    // The trap, and it is a copy of the pin's. `SessionActivityMeta` bails out
    // early when it has neither an activity map nor a clock, which is the shape
    // the rail is rendered in outside the app. The shared helper passes a clock,
    // so without this override the guard is never reached and any change to it
    // is invisible here.
    const html = render({
      starredSessions: { mvs_starred: true },
      activity: undefined,
      now: undefined,
    });
    expect(rowSlice(html, "mvs_starred")).toContain(MARK);
  });

  it("still renders no meta block for a host with no clock, no activity and no marks", () => {
    // The other half of the same guard, so widening it for a star cannot leave
    // an empty element on every row -- which is what keeps the existing
    // snapshots byte-identical.
    const html = render({
      starredSessions: undefined,
      pinnedSessions: undefined,
      activity: undefined,
      now: undefined,
    });
    expect(html).not.toContain(MARK);
    expect(html).not.toContain("webui-rail-session-meta");
  });

  it("keeps the mark outside the hover-only action strip", () => {
    const html = render({ starredSessions: { mvs_starred: true } });
    const strips = html.match(/<div class="webui-session-row-actions">[\s\S]*?<\/div>/gu) ?? [];
    expect(strips.length).toBeGreaterThan(0);
    for (const chunk of strips) expect(chunk).not.toContain(MARK);
  });

  it("draws something inside the mark, not just a hook", () => {
    const html = render({ starredSessions: { mvs_starred: true } });
    const mark = html.match(/<span class="webui-rail-star-mark"[^>]*>([\s\S]*?)<\/span>/u);
    expect(mark, "the star mark wrapper is missing").not.toBeNull();
    expect(mark?.[1] ?? "").toMatch(/<svg[\s\S]*?<path/u);
  });

  it("lists the starred sessions under the favourites tab", () => {
    // Through WebuiProjectList, not by calling the filter directly: a passthrough
    // that was never wired still leaves every filter test green.
    const html = render({
      view: "stars",
      starredSessions: { mvs_starred: true },
    });
    expect(html).toContain('data-webui-rail-view-active="stars"');
    expect(html).toContain('data-webui-rail-view="stars"');
    expect(html).toContain('data-webui-session-link="mvs_starred"');
    expect(html).not.toContain('data-webui-session-link="mvs_plain"');
  });

  it("puts a count on the favourites tab", () => {
    const html = render({ starredSessions: { mvs_starred: true, mvs_plain: true } });
    expect(html).toMatch(/data-webui-rail-view-count="stars"[^>]*>2</u);
  });

  it("draws the starred row in the flat list the favourites view renders", () => {
    // The view goes through WebuiSessionList, which has its own copy of the row
    // and its own meta call site.
    const html = render({ view: "stars", starredSessions: { mvs_plain: true } });
    const at = html.indexOf('data-webui-session-link="mvs_plain"');
    expect(at).toBeGreaterThanOrEqual(0);
    expect(rowSlice(html, "mvs_plain")).toContain(MARK);
  });

  it("wires the starred flag into the child row's meta call", () => {
    // Source-level, for the same structural reason as the pin: child rows render
    // only from internal `useState` that no prop seeds, and this suite has no
    // DOM to click the disclosure with. The browser spec covers the real thing.
    const source = readFileSync(
      new URL("../../src/client/components/SessionRail.tsx", import.meta.url),
      "utf8",
    );
    const anchor = source.indexOf("session={child}");
    expect(anchor, "the child row's meta call is gone entirely").toBeGreaterThanOrEqual(0);
    expect(source.slice(anchor, anchor + 400)).toContain(
      "starred={Boolean(starredSessions?.[child.sessionId])}",
    );
  });

  it("keeps pin and star as separate signals on the same row", () => {
    // They are independent decisions and the row has to be able to show both:
    // a pinned session that is not a favourite, and vice versa.
    const pinnedOnly = render({ pinnedSessions: { mvs_starred: true } });
    expect(rowSlice(pinnedOnly, "mvs_starred")).toContain('data-webui-pin-mark="true"');
    expect(rowSlice(pinnedOnly, "mvs_starred")).not.toContain(MARK);

    const starredOnly = render({ starredSessions: { mvs_starred: true } });
    expect(rowSlice(starredOnly, "mvs_starred")).toContain(MARK);
    expect(rowSlice(starredOnly, "mvs_starred")).not.toContain('data-webui-pin-mark="true"');
  });
});
