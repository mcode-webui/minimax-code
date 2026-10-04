import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import {
  filterWebuiRailViewSessions,
  selectWebuiRailViewTabs,
  type WebuiRailView,
} from "../../src/client/rail-buckets.js";
import { WebuiProjectList } from "../../src/client/components/SessionRail.js";
import type { WebuiSessionActivityMap } from "../../src/client/session-activity.js";
import type { WebuiClientSession } from "../../src/client/contracts.js";

function session(
  sessionId: string,
  updatedAt: number,
  over: Partial<WebuiClientSession> = {},
): WebuiClientSession {
  return {
    sessionId,
    agentName: "main",
    createdAt: 0,
    updatedAt,
    ...over,
  };
}

const BUSY: WebuiSessionActivityMap = {
  mvs_a: { lastActivityAt: 5_000, busy: { turnId: "t1", busyReason: "turn" } },
  mvs_b: { lastActivityAt: 9_000, unread: 3 },
  mvs_c: { lastActivityAt: 7_000, unread: 1, busy: { turnId: "t2", busyReason: "turn" } },
  mvs_d: { lastActivityAt: 3_000 },
};

const SESSIONS: readonly WebuiClientSession[] = [
  session("mvs_a", 1),
  session("mvs_b", 2),
  session("mvs_c", 3),
  session("mvs_d", 4),
  session("mvs_e", 5),
];

const ids = (list: readonly WebuiClientSession[]): string[] =>
  list.map((entry) => entry.sessionId);

const tab = (view: WebuiRailView) =>
  selectWebuiRailViewTabs(SESSIONS, BUSY).find((entry) => entry.view === view);

describe("selectWebuiRailViewTabs", () => {
  it("offers the three views, projects first", () => {
    expect(selectWebuiRailViewTabs(SESSIONS, BUSY).map((entry) => entry.view)).toEqual([
      "projects",
      "running",
      "unread",
    ]);
  });

  it("counts the running sessions across projects", () => {
    // Cross-project aggregation is the whole point of the view: these two sit
    // in different projects in the real rail, and neither project shows the
    // other one's turn.
    expect(tab("running")?.count).toBe(2);
  });

  it("counts unread without double-counting a session that is also running", () => {
    // mvs_c is both. Counting it twice would make the two tabs disagree with
    // the sum the user can actually reconcile against the rows.
    expect(tab("unread")?.count).toBe(1);
  });

  it("counts zero rather than going negative or blank when nothing is running", () => {
    const idle = selectWebuiRailViewTabs(SESSIONS, {});
    expect(idle.find((entry) => entry.view === "running")?.count).toBe(0);
    expect(idle.find((entry) => entry.view === "unread")?.count).toBe(0);
  });

  it("reports the project view as the full list, because that view is not a filter", () => {
    expect(tab("projects")?.count).toBe(SESSIONS.length);
  });

  it("survives having no activity map at all", () => {
    const tabs = selectWebuiRailViewTabs(SESSIONS, undefined);
    expect(tabs.find((entry) => entry.view === "running")?.count).toBe(0);
    expect(tabs.find((entry) => entry.view === "unread")?.count).toBe(0);
    expect(tabs[0]?.count).toBe(SESSIONS.length);
    expect(tabs).toHaveLength(3);
  });
});

describe("filterWebuiRailViewSessions", () => {
  it("keeps every session in the project view", () => {
    // The project view is the existing rail, unchanged. If this ever filtered,
    // sessions would silently disappear from the default view.
    expect(filterWebuiRailViewSessions(SESSIONS, BUSY, "projects")).toHaveLength(
      SESSIONS.length,
    );
  });

  it("keeps only the running sessions", () => {
    expect(ids(filterWebuiRailViewSessions(SESSIONS, BUSY, "running"))).toEqual([
      "mvs_c",
      "mvs_a",
    ]);
  });

  it("keeps only the unread sessions that are not already running", () => {
    // A session already listed under "running" is not unread *to act on* --
    // it is mid-answer. Listing it twice in two views is the duplication this
    // whole tab switch exists to avoid.
    expect(ids(filterWebuiRailViewSessions(SESSIONS, BUSY, "unread"))).toEqual(["mvs_b"]);
  });

  it("orders a view by last activity, newest first", () => {
    // A fixture where the two orderings disagree, because with SESSIONS they
    // agree by accident: every session there is newer in both keys, so sorting
    // by `updatedAt` alone would produce the same list and the assertion below
    // would pass no matter which key the sort used.
    //
    // mvs_slow moved at 100ms but its record was written last; mvs_fresh moved
    // at 900ms with an older record. Last-observed activity is what the reader
    // watched happen, so mvs_fresh leads.
    const activity: WebuiSessionActivityMap = {
      mvs_slow: { lastActivityAt: 100, busy: { turnId: "t1", busyReason: "turn" } },
      mvs_fresh: { lastActivityAt: 900, busy: { turnId: "t2", busyReason: "turn" } },
    };
    const sessions = [session("mvs_slow", 900), session("mvs_fresh", 100)];
    expect(ids(filterWebuiRailViewSessions(sessions, activity, "running"))).toEqual([
      "mvs_fresh",
      "mvs_slow",
    ]);
    // And the wrong key really would give the other answer, so this test is
    // not passing for a reason unrelated to what it claims.
    expect([...sessions].sort((l, r) => r.updatedAt - l.updatedAt).map((s) => s.sessionId)).toEqual([
      "mvs_slow",
      "mvs_fresh",
    ]);
  });

  it("ignores activity for sessions that are not in the page", () => {
    // The activity map outlives the page: an archived session, or one the list
    // has not paged in yet, keeps its entry. Counting those would put a number
    // on the tab that no row can ever account for.
    const stale: WebuiSessionActivityMap = {
      ...BUSY,
      mvs_gone: { lastActivityAt: 9_999, unread: 7, busy: { turnId: "t9", busyReason: "turn" } },
    };
    expect(selectWebuiRailViewTabs(SESSIONS, stale).find((e) => e.view === "running")?.count).toBe(2);
    expect(selectWebuiRailViewTabs(SESSIONS, stale).find((e) => e.view === "unread")?.count).toBe(1);
    expect(ids(filterWebuiRailViewSessions(SESSIONS, stale, "running"))).toEqual([
      "mvs_c",
      "mvs_a",
    ]);
  });

  it("never mutates the input order or the input array", () => {
    const input = [...SESSIONS];
    const before = ids(input);
    filterWebuiRailViewSessions(input, BUSY, "running");
    filterWebuiRailViewSessions(input, BUSY, "unread");
    expect(ids(input)).toEqual(before);
  });

  it("returns an empty list rather than throwing for a view nothing matches", () => {
    expect(
      filterWebuiRailViewSessions([session("mvs_x", 1)], {}, "unread"),
    ).toEqual([]);
  });
});

describe("the rail view tabs", () => {
  const NOW = 1_000_000;
  const page = { sessions: SESSIONS, hasMore: false };
  const render = (
    view?: WebuiRailView,
    over: {
      readonly page?: { sessions: readonly WebuiClientSession[]; hasMore: boolean };
      readonly activity?: WebuiSessionActivityMap;
    } = {},
  ) =>
    renderToStaticMarkup(
      createElement(WebuiProjectList, {
        page: over.page ?? page,
        loading: false,
        activity: over.activity ?? BUSY,
        now: NOW,
        ...(view ? { view } : {}),
      }),
    );

  it("offers all three tabs, with the project view selected by default", () => {
    const html = render();
    expect(html).toMatch(/data-webui-rail-view="projects"/u);
    expect(html).toMatch(/data-webui-rail-view="running"/u);
    expect(html).toMatch(/data-webui-rail-view="unread"/u);
    expect(html).toMatch(/data-webui-rail-view="projects"[^>]*aria-selected="true"/u);
  });

  it("puts the count on each tab, and not on the project view", () => {
    // A number on the project tab would be the page size, which is not what
    // anyone reads a tab for, and it moves every time the list pages.
    const html = render();
    expect(html).toMatch(/data-webui-rail-view-count="running"[^>]*>2</u);
    expect(html).toMatch(/data-webui-rail-view-count="unread"[^>]*>1</u);
    expect(html).not.toMatch(/data-webui-rail-view-count="projects"/u);
  });

  it("shows every session in the project view, which is the rail as it was", () => {
    const html = render("projects");
    for (const entry of SESSIONS) {
      expect(html, entry.sessionId).toContain(`data-webui-session-link="${entry.sessionId}"`);
    }
  });

  it("keeps the project grouping in the project view", () => {
    // The links alone are not enough. A view that listed every session flat
    // would pass every check above while quietly losing the project tree, the
    // per-project collapse and the per-project paging. That is the rail, gone.
    const html = render("projects");
    expect(html).toMatch(/data-webui-project-list-items="true"/u);
    // The project header carries the collapse control; without it the group
    // cannot be folded and the tree is a flat list wearing a heading.
    expect(html).toMatch(/aria-expanded="(?:true|false)"/u);
  });

  it("does not claim a project grouping in the status views", () => {
    // A filtered view is one flat list; drawing project furniture around it
    // would imply the rows are grouped when they are not.
    expect(render("running")).not.toMatch(/data-webui-project-list-items="true"/u);
    expect(render("unread")).not.toMatch(/data-webui-project-list-items="true"/u);
  });

  it("draws the rows in the view's order, not the page's", () => {
    // Same reasoning as the sorting test above, one layer up: with SESSIONS the
    // two orderings coincide, so this would pass with the list re-sorting
    // itself by `updatedAt` and undoing the view's ordering without complaint.
    const html = render("running", {
      page: { hasMore: false, sessions: [session("mvs_slow", 900), session("mvs_fresh", 100)] },
      activity: {
        mvs_slow: { lastActivityAt: 100, busy: { turnId: "t1", busyReason: "turn" } },
        mvs_fresh: { lastActivityAt: 900, busy: { turnId: "t2", busyReason: "turn" } },
      },
    });
    expect(html.indexOf('data-webui-session-link="mvs_fresh"')).toBeLessThan(
      html.indexOf('data-webui-session-link="mvs_slow"'),
    );
  });

  it("lists only the running sessions in the running view", () => {
    const html = render("running");
    expect(html).toMatch(/data-webui-session-link="mvs_a"/u);
    expect(html).toMatch(/data-webui-session-link="mvs_c"/u);
    expect(html).not.toMatch(/data-webui-session-link="mvs_b"/u);
    expect(html).not.toMatch(/data-webui-session-link="mvs_e"/u);
  });

  it("lists only the unread sessions in the unread view", () => {
    const html = render("unread");
    expect(html).toMatch(/data-webui-session-link="mvs_b"/u);
    expect(html).not.toMatch(/data-webui-session-link="mvs_a"/u);
    expect(html).not.toMatch(/data-webui-session-link="mvs_c"/u);
  });

  it("shows no session twice, which is the whole reason for the switch", () => {
    // The failure this guards against is not a crash but a quietly worse rail:
    // every unread session appearing under its project AND in a tab.
    for (const view of ["projects", "running", "unread"] as const) {
      const html = render(view);
      const links = html.match(/data-webui-session-link="[^"]+"/gu) ?? [];
      expect(new Set(links).size, `${view} repeats a session`).toBe(links.length);
    }
  });

  it("marks the active view on the section, not only on the tab", () => {
    // The section attribute is what a test or a stylesheet can key on; a tab
    // that merely looks selected gives neither.
    expect(render("unread")).toMatch(/data-webui-rail-view-active="unread"/u);
  });

  it("keeps the spinner and the badge on rows inside the views", () => {
    // The tabs are an aggregate entry point, not a replacement for the row's
    // own state: a running row in the running view still has to say so.
    expect(render("running")).toMatch(/webui-rail-spinner/u);
    expect(render("unread")).toMatch(/webui-rail-unread-badge/u);
  });

  it("gives each view an empty state that names the view", () => {
    // "No sessions yet" would be false in these tabs. There are plenty of
    // sessions; there are just none of the kind this tab collects, and the
    // reader needs to know which kind they emptied.
    const labels = new Map(
      selectWebuiRailViewTabs(SESSIONS, BUSY).map((entry) => [entry.view, entry.emptyLabel]),
    );
    expect(labels.get("running")).toBe("没有运行中的会话");
    expect(labels.get("unread")).toBe("没有未读会话");
    expect(new Set(labels.values()).size).toBe(3);
  });

  it("keeps no English in a Chinese rail", () => {
    // The rail is Chinese throughout. An untranslated string here is how
    // "Waiting messages" and "No sessions yet" got shipped in the first place.
    for (const entry of selectWebuiRailViewTabs(SESSIONS, BUSY)) {
      expect(entry.label, entry.view).not.toMatch(/[A-Za-z]{2,}/u);
      expect(entry.emptyLabel, entry.view).not.toMatch(/[A-Za-z]{2,}/u);
    }
  });

  it("renders the view's own empty state when it matches nothing", () => {
    const html = render("unread", {
      page: { hasMore: false, sessions: [session("mvs_quiet", 1)] },
      activity: {},
    });
    expect(html).toMatch(/没有未读会话/u);
    expect(html).not.toMatch(/No sessions yet/u);
  });
});

describe("the view tab styling", () => {
  const shellCss = readFileSync(
    path.join(import.meta.dirname, "..", "..", "src", "client", "styles", "shell.css"),
    "utf8",
  );
  // Comments come off first: the rules are commented at length about why the
  // views are a switch rather than a stack, and matching against that prose
  // would make the "no raw hex" assertion fire on the explanation.
  const rule = (selector: string): string => {
    const start = shellCss.indexOf(selector);
    if (start < 0) return "";
    return shellCss
      .slice(start, shellCss.indexOf("}", start))
      .replace(/\/\*[\s\S]*?\*\//gu, "")
      .trim();
  };

  it("styles the tab row and the selected tab at all", () => {
    // Every other assertion here reads a rule body, and an empty string passes
    // a regex. The file is free to lose the whole block and stay green
    // otherwise.
    expect(rule(".webui-rail-view-tabs {")).not.toBe("");
    expect(rule('.webui-rail-view-tab[aria-selected="true"] {')).not.toBe("");
  });

  it("keys the selected tab off aria-selected, so it cannot drift from the a11y state", () => {
    // A class written in JSX and a selector written in CSS are two places to
    // keep in step. `aria-selected` is already true on exactly that button, and
    // a screen reader reads it, so the stylesheet follows it rather than
    // inventing a second source of truth.
    expect(shellCss).toMatch(/\.webui-rail-view-tab\[aria-selected="true"\]/u);
  });

  it("does not reach for a raw hex, which would not follow the theme", () => {
    expect(rule(".webui-rail-view-tabs {")).not.toMatch(/#[0-9a-f]{3,8}/iu);
    expect(rule(".webui-rail-view-count {")).not.toMatch(/#[0-9a-f]{3,8}/iu);
  });

  it("gives the count a pill rather than letting it run into the label", () => {
    // A bare number in the tab reads as part of the word next to it.
    const count = rule(".webui-rail-view-count {");
    expect(count).toMatch(/border-radius/u);
    expect(count).toMatch(/min-width/u);
  });
});
