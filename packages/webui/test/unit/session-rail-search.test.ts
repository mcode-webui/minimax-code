// Rail session search — the pure filter the shell's search input drives.
//
// The search button used to be a permanently disabled placeholder
// (`aria-disabled` + `disabled` hardcoded, with no query state anywhere in the
// client), so these tests start from the behaviour the rail needs rather than
// from the placeholder: a query narrows the rendered list, an empty query does
// not, and the match is a case-insensitive substring over the label the rail
// already renders plus the workspace directory.
//
// The load-bearing case is the narrowing one. A filter that quietly returned
// every session would pass any "does not throw" test while the feature did
// nothing, so the cases below assert exact output arrays and exact counts.
//
// The project filter was added after the session filter was already green: a
// real session search was unusable because projects with no surviving sessions
// still rendered as empty rows. Its cases are bidirectional on purpose — one
// pins that empty projects are dropped, the other that a project the query
// names is kept, so neither half of the `||` can be implemented alone.

import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import type { WebuiClientProject, WebuiClientSession } from "../../src/client/contracts.js";
import {
  WebuiProjectList,
  filterWebuiProjectsByQuery,
  filterWebuiSessionsByQuery,
  matchesWebuiProjectQuery,
  matchesWebuiSessionQuery,
  sessionLabel,
  type WebuiProjectGroup,
} from "../../src/client/components/SessionRail.js";

const session = (over: Partial<WebuiClientSession> & { sessionId: string }): WebuiClientSession => ({
  agentName: "main",
  createdAt: 1,
  updatedAt: 10,
  ...over,
});

const SESSIONS: readonly WebuiClientSession[] = [
  session({ sessionId: "s1", title: "修复终端 SHELL 解析", workspaceDir: "/work/minimax-code" }),
  session({ sessionId: "s2", title: "Add mermaid rendering", workspaceDir: "/work/other" }),
  session({ sessionId: "s3", agentName: "reviewer", workspaceDir: "/work/minimax-code" }),
  session({ sessionId: "s4", title: "   ", workspaceDir: "/work/scratch" }),
];

describe("sessionLabel", () => {
  it("prefers a trimmed title, then the agent name, then the id", () => {
    expect(sessionLabel(SESSIONS[0]!)).toBe("修复终端 SHELL 解析");
    expect(sessionLabel(SESSIONS[2]!)).toBe("reviewer");
    // A whitespace-only title is not a title — it must fall through rather than
    // render as a blank rail row.
    expect(sessionLabel(SESSIONS[3]!)).toBe("main");
    expect(sessionLabel(session({ sessionId: "s5", agentName: "" }))).toBe("s5");
  });
});

describe("matchesWebuiSessionQuery", () => {
  it("matches a title substring without regard to case", () => {
    expect(matchesWebuiSessionQuery(SESSIONS[0]!, "终端")).toBe(true);
    expect(matchesWebuiSessionQuery(SESSIONS[1]!, "MERMAID")).toBe(true);
    expect(matchesWebuiSessionQuery(SESSIONS[1]!, "mermaid")).toBe(true);
  });

  it("falls back to the agent name when the session has no title", () => {
    expect(matchesWebuiSessionQuery(SESSIONS[2]!, "reviewer")).toBe(true);
  });

  it("matches the workspace directory so a project path is findable", () => {
    expect(matchesWebuiSessionQuery(SESSIONS[0]!, "minimax-code")).toBe(true);
    expect(matchesWebuiSessionQuery(SESSIONS[0]!, "WORK/MINIMAX")).toBe(true);
    expect(matchesWebuiSessionQuery(SESSIONS[1]!, "minimax-code")).toBe(false);
  });

  it("treats an empty or whitespace-only query as a match", () => {
    for (const query of ["", " ", "\t", "\n  "]) {
      expect(matchesWebuiSessionQuery(SESSIONS[0]!, query)).toBe(true);
    }
  });

  it("rejects a query that matches nothing", () => {
    expect(matchesWebuiSessionQuery(SESSIONS[0]!, "nonexistent-token")).toBe(false);
  });

  it("does not match a session that has no workspace directory", () => {
    const orphan = session({ sessionId: "s6", title: "orphan" });
    expect(matchesWebuiSessionQuery(orphan, "work")).toBe(false);
    expect(matchesWebuiSessionQuery(orphan, "orphan")).toBe(true);
  });
});

describe("filterWebuiSessionsByQuery", () => {
  it("narrows to exactly the matching sessions", () => {
    // The narrowing contract. An implementation that returned its input
    // unchanged would fail here on both the list and the count.
    const result = filterWebuiSessionsByQuery(SESSIONS, "minimax-code");
    expect(result.map((entry) => entry.sessionId)).toEqual(["s1", "s3"]);
    expect(result).toHaveLength(2);
    expect(result.length).toBeLessThan(SESSIONS.length);
  });

  it("returns an empty list when nothing matches", () => {
    const result = filterWebuiSessionsByQuery(SESSIONS, "zzz-no-such-session");
    expect(result).toEqual([]);
  });

  it("returns the input unchanged for an empty query", () => {
    for (const query of ["", "   "]) {
      expect(filterWebuiSessionsByQuery(SESSIONS, query)).toEqual([...SESSIONS]);
    }
  });

  it("preserves the caller's order", () => {
    // "minimax-code" hits s1 and s3 only, so the result order is the input
    // order and not a re-sort.
    const result = filterWebuiSessionsByQuery(SESSIONS, "minimax-code");
    expect(result.map((entry) => entry.sessionId)).toEqual(["s1", "s3"]);
    const reversed = filterWebuiSessionsByQuery([...SESSIONS].reverse(), "minimax-code");
    expect(reversed.map((entry) => entry.sessionId)).toEqual(["s3", "s1"]);
  });

  it("matches on the id when neither title nor agent name is usable", () => {
    const idOnly = [session({ sessionId: "needle-in-haystack", agentName: "" })];
    expect(filterWebuiSessionsByQuery(idOnly, "needle")).toHaveLength(1);
  });
});

const project = (over: Partial<WebuiProjectGroup> & { key: string }): WebuiProjectGroup => ({
  name: over.key,
  latestSessionId: "",
  sessionIds: [],
  updatedAt: 10,
  ...over,
});

// The full, unfiltered session page a real rail would hold. `railProjects`
// derives each project's `sessionIds` from *this* list through the real
// session filter, because that is what production does: the session list is
// filtered first, and only the project row's `sessionIds` is a product of
// that. Hand-writing `sessionIds` per query produced a fixture that claimed
// a project kept its sessions under every query, which no real rail can do.
const ALL_SESSIONS: readonly WebuiClientSession[] = [
  session({ sessionId: "s1", title: "修复终端 SHELL 解析", workspaceDir: "/work/minimax-code" }),
  session({ sessionId: "s3", title: "Add mermaid rendering", workspaceDir: "/work/minimax-code" }),
  session({ sessionId: "s9", title: "feishu bot 调试", workspaceDir: "/work/mcode-feishu-live" }),
  // Matches by title only. Its project row spells neither the title nor the
  // directory, so this session is the sole reason the project clause below has
  // to exist: drop it and the row holding the one matching session disappears.
  session({ sessionId: "s5", title: "查看今日日志", workspaceDir: "/work/misc-scratch" }),
];

const UNASSIGNED = "__webui_unassigned_project__";

/** The project rows a rail would hold for `query`, mirroring the two stages. */
const railProjects = (query: string): readonly WebuiProjectGroup[] => {
  const survivors = filterWebuiSessionsByQuery(ALL_SESSIONS, query);
  const idsIn = (workspaceDir?: string): readonly string[] =>
    survivors.filter((entry) => (entry.workspaceDir?.trim() || UNASSIGNED) === (workspaceDir ?? UNASSIGNED)).map((entry) => entry.sessionId);
  return [
    project({ key: "/work/minimax-code", name: "minimax-code", workspaceDir: "/work/minimax-code", sessionIds: idsIn("/work/minimax-code") }),
    project({ key: "/work/mcode-feishu-live", name: "mcode-feishu-live", workspaceDir: "/work/mcode-feishu-live", sessionIds: idsIn("/work/mcode-feishu-live") }),
    project({ key: "/work/misc-scratch", name: "misc-scratch", workspaceDir: "/work/misc-scratch", sessionIds: idsIn("/work/misc-scratch") }),
    // A real project with no session on the loaded page — the paging case the
    // name clause exists for, since a project is findable before its sessions
    // have been paged in.
    project({ key: "/work/empty-scratch", name: "empty-scratch", workspaceDir: "/work/empty-scratch" }),
    project({ key: UNASSIGNED, name: "未选项目", sessionIds: idsIn(undefined) }),
  ];
};

const PROJECTS: readonly WebuiProjectGroup[] = railProjects("");
// Named so the assertions below survive a fixture row being added or removed.
const MINIMAX = PROJECTS.find((entry) => entry.key === "/work/minimax-code")!;
const UNASSIGNED_ROW = PROJECTS.find((entry) => entry.key === UNASSIGNED)!;

describe("matchesWebuiProjectQuery", () => {
  it("matches the project name without regard to case", () => {
    expect(matchesWebuiProjectQuery(MINIMAX, "minimax")).toBe(true);
    expect(matchesWebuiProjectQuery(MINIMAX, "MINIMAX-CODE")).toBe(true);
  });

  it("matches a path that only the workspace directory spells out", () => {
    const nested = project({ key: "k", name: "app", workspaceDir: "/srv/deep/nested/dir" });
    expect(matchesWebuiProjectQuery(nested, "nested/dir")).toBe(true);
    expect(matchesWebuiProjectQuery(nested, "nowhere")).toBe(false);
    // The name "app" cannot rescue either assertion, so a case-sensitive
    // directory comparison would fail them.
    const cased = project({ key: "k", name: "svc", workspaceDir: "/SRV/Deep/Nested/Dir" });
    expect(matchesWebuiProjectQuery(cased, "nested/dir")).toBe(true);
    expect(matchesWebuiProjectQuery(cased, "NESTED/DIR")).toBe(true);
    expect(filterWebuiProjectsByQuery([cased], "NESTED/DIR")).toHaveLength(1);
  });

  it("treats an empty or whitespace-only query as a match", () => {
    for (const query of ["", " ", "\t\n "]) {
      expect(matchesWebuiProjectQuery(UNASSIGNED_ROW, query)).toBe(true);
    }
  });

  it("matches the name case-insensitively when only the name spells it out", () => {
    // Guards the name clause on its own. Every other fixture spells its query
    // in the workspace directory too, so a case-sensitive name comparison
    // survived them; this project matches by name and nothing else.
    const renamed = project({ key: "/srv/other", name: "MyApp", workspaceDir: "/srv/other" });
    expect(matchesWebuiProjectQuery(renamed, "myapp")).toBe(true);
    expect(matchesWebuiProjectQuery(renamed, "MYAPP")).toBe(true);
    expect(filterWebuiProjectsByQuery([renamed], "myapp")).toHaveLength(1);
  });

  it("rejects a query that matches nothing", () => {
    expect(matchesWebuiProjectQuery(MINIMAX, "zzz-no-such-project")).toBe(false);
    expect(matchesWebuiProjectQuery(UNASSIGNED_ROW, "未选项目x")).toBe(false);
  });
});

describe("filterWebuiProjectsByQuery", () => {
  it("drops a project whose every session was filtered out", () => {
    // The load-bearing case, found on a real workspace: `mcode-feishu-live`
    // has no session matching "minimax-code", yet the rail rendered it as an
    // empty row because project rows come from `projectRecords`, not from the
    // session list. Asserting the exact surviving keys fails if this is a
    // no-op, and fails if it filters on project name alone.
    const result = filterWebuiProjectsByQuery(railProjects("minimax-code"), "minimax-code");
    expect(result.map((entry) => entry.key)).toEqual(["/work/minimax-code"]);
    expect(result.some((entry) => entry.name === "mcode-feishu-live")).toBe(false);
    expect(result.length).toBeLessThan(railProjects("minimax-code").length);
  });

  it("keeps a project whose session matched by title, not by project name", () => {
    // The other direction, and the only case where the session clause is
    // observable at all. "查看" hits the title of `s5`; neither "misc-scratch"
    // nor "/work/misc-scratch" contains it, so a name-only filter hides the one
    // row that still has a result under it. This is the shape a real search
    // takes whenever the user types part of a session title.
    const query = "查看";
    const result = filterWebuiProjectsByQuery(railProjects(query), query);
    expect(result.map((entry) => entry.key)).toEqual(["/work/misc-scratch"]);
    expect(result[0]!.sessionIds).toEqual(["s5"]);
    expect(filterWebuiSessionsByQuery(ALL_SESSIONS, query).map((entry) => entry.sessionId)).toEqual(["s5"]);
  });

  it("keeps a project the query names even when no session is loaded for it", () => {
    // The counterweight to the case above. A filter that only consulted
    // `sessionIds.length` would pass the drop test while making a project's
    // row unsearchable by name until its sessions happened to page in.
    const result = filterWebuiProjectsByQuery(railProjects("empty-scratch"), "empty-scratch");
    expect(result.map((entry) => entry.key)).toEqual(["/work/empty-scratch"]);
    expect(result[0]!.sessionIds).toEqual([]);
  });

  it("narrows to every project that still holds a matching session", () => {
    // A query hitting the shared `/work/` prefix: every workspace row survives,
    // three of them via the session clause and one (`empty-scratch`, unloaded)
    // via the name clause, while the unassigned row drops out.
    const input = railProjects("/work/");
    const result = filterWebuiProjectsByQuery(input, "/work/");
    expect(result.map((entry) => entry.key)).toEqual([
      "/work/minimax-code",
      "/work/mcode-feishu-live",
      "/work/misc-scratch",
      "/work/empty-scratch",
    ]);
    expect(result.length).toBeLessThan(input.length);
  });

  it("returns an empty list when nothing matches", () => {
    // Note the input is built for the *same* query. Passing the unfiltered
    // `railProjects("")` here keeps every `sessionIds` populated, so those
    // projects would (correctly) survive — a fixture mistake, not a filter bug.
    const query = "zzz-no-such-project";
    expect(filterWebuiProjectsByQuery(railProjects(query), query)).toEqual([]);
  });

  it("returns the same array instance for an empty query", () => {
    for (const query of ["", "   "]) {
      expect(filterWebuiProjectsByQuery(PROJECTS, query)).toBe(PROJECTS);
    }
  });

  it("preserves the caller's order rather than re-sorting", () => {
    // The rail sorts by pin/recency after this filter runs, so sorting here
    // too would double-apply it. Feed a reversed order and require it back.
    const byName = [...railProjects("empty-scratch")].reverse();
    expect(filterWebuiProjectsByQuery(byName, "empty-scratch").map((entry) => entry.key)).toEqual([
      "/work/empty-scratch",
    ]);
    const byDir = [...railProjects("/work/")].reverse();
    expect(filterWebuiProjectsByQuery(byDir, "/work/").map((entry) => entry.key)).toEqual([
      "/work/empty-scratch",
      "/work/misc-scratch",
      "/work/mcode-feishu-live",
      "/work/minimax-code",
    ]);
  });
});

// The pure filters above are the contract; this renders the component they
// drive, because the bug was reported from a running rail, not from a unit
// test. `projectRecords` is the whole workspace while `page.sessions` is the
// filtered page, exactly as `WebuiClientFoundationApp` assembles them.
const projectRecord = (
  projectId: number,
  workspaceDir: string,
  latestActivityAtMs: number,
  sessionCount: number,
): WebuiClientProject => ({
  projectId,
  projectKind: "workspace",
  workspaceDir,
  pinned: false,
  hidden: false,
  orderIndex: projectId,
  recentAtMs: latestActivityAtMs,
  latestActivityAtMs,
  sessionCount,
});

const RAIL_PROJECTS: readonly WebuiClientProject[] = [
  projectRecord(1, "/work/minimax-code", 30, 2),
  projectRecord(2, "/work/mcode-feishu-live", 20, 1),
  projectRecord(3, "/work/empty-scratch", 10, 0),
];

const renderRail = (query: string): string =>
  renderToStaticMarkup(
    createElement(WebuiProjectList, {
      page: { sessions: filterWebuiSessionsByQuery(ALL_SESSIONS, query), hasMore: false },
      projectRecords: RAIL_PROJECTS,
      query,
      loading: false,
    }),
  );

describe("WebuiProjectList under a search query", () => {
  it("renders no row for a project whose sessions all filtered out", () => {
    // The reported failure, verbatim: searching "minimax-code" left
    // `mcode-feishu-live` on screen as a project row with nothing under it.
    const html = renderRail("minimax-code");
    expect(html).toContain('data-webui-project-list="true"');
    expect(html).toContain("minimax-code");
    expect(html).not.toContain("mcode-feishu-live");
    expect(html).not.toContain("empty-scratch");
  });

  it("keeps a project the query names even with no session on the page", () => {
    const html = renderRail("empty-scratch");
    expect(html).toContain("empty-scratch");
    expect(html).not.toContain("mcode-feishu-live");
  });

  it("renders every project row when there is no query", () => {
    const html = renderRail("");
    expect(html).toContain("minimax-code");
    expect(html).toContain("mcode-feishu-live");
    expect(html).toContain("empty-scratch");
  });
});
// The filters above are covered by behaviour; the two lines that connect the
// search box to them are not reachable any other way. `WebuiClientFoundationApp`
// needs a live transport to render, and this suite has no DOM environment, so
// — like the `RailRow` wiring check in webui-shell.test.ts — this reads the
// source and pins the bindings. It is weaker than a render and is named as
// such: it proves the query reaches both consumers, not that the screen looks
// right. The screen was checked by hand against a real rail.
describe("rail search wiring in WebuiClientFoundationApp", () => {
  const source = readFileSync(
    new URL("../../src/client/components/WebuiClientFoundationApp.tsx", import.meta.url),
    "utf8",
  );

  it("holds the query in one state and feeds it to the input", () => {
    expect(source).toMatch(/const \[railSearchQuery, setRailSearchQuery\] = useState\(""\)/u);
    expect(source).toMatch(/value=\{railSearchQuery\}/u);
  });

  it("filters the session page the rail renders with that same query", () => {
    // Without this the projects come from the unfiltered page and the whole
    // feature is inert while every test stays green.
    expect(source).toMatch(
      /filterWebuiSessionsByQuery\(page\.sessions, railSearchQuery\)/u,
    );
    expect(source).toMatch(/filterWebuiSessionsByQuery\(node\.childSessions, railSearchQuery\)/u);
  });

  it("passes the query into the project list it renders", () => {
    // Scoped to the `<WebuiProjectList .../>` element itself: a `railSearchQuery`
    // elsewhere in the file would otherwise satisfy a bare substring check.
    const start = source.indexOf("<WebuiProjectList");
    expect(start).toBeGreaterThan(-1);
    const end = source.indexOf("/>", start);
    expect(end).toBeGreaterThan(start);
    const element = source.slice(start, end);
    expect(element).toMatch(/query=\{railSearchQuery\}/u);
    expect(element).toMatch(/page=\{railPage\}/u);
  });
});