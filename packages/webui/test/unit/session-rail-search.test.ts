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

import { describe, expect, it } from "vitest";
import type { WebuiClientSession } from "../../src/client/contracts.js";
import {
  filterWebuiSessionsByQuery,
  matchesWebuiSessionQuery,
  sessionLabel,
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
