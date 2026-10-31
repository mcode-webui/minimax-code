// The session entity catalog and the session workflows.
//
// These are the deterministic application tests:
// flat and tree resolve from one entity map (so a rename cannot leave two
// copies disagreeing), and the loads/mutations run through the workflow
// surface against a scripted port.

import { describe, expect, it } from "vitest";
import { createWebuiSessionComposerAccess } from "../../src/client/features/sessions/application/session-workflows.js";

import { createWebuiSessionCatalogFromPage, patchWebuiCatalogEntity, reduceWebuiCatalogFlatAppended, reduceWebuiCatalogFlatLoaded, reduceWebuiCatalogTreeLoaded, removeWebuiCatalogEntities } from "../../src/client/features/sessions/application/session-catalog.js";
import { initialWebuiSessionCatalogState, selectWebuiCatalogFlatPage, selectWebuiCatalogTreePage } from "../../src/client/features/sessions/application/session-catalog.public.js";
import { createWebuiSessionStore } from "../../src/client/application/session-store.js";
import { createWebuiSessionWorkflows } from "../../src/client/features/sessions/application/session-workflows.js";
import { createWebuiSessionScopeManager } from "../../src/client/conversation/session-scope.js";
import { selectWebuiWorkspaceProgress } from "../../src/client/features/workspace/projection/workspace-progress.js";
import type { WebuiClientSession } from "../../src/client/features/sessions/contracts/session-view.js";
import { selectWebuiSessionAgentName, selectWebuiSessionLookups } from "../../src/client/features/sessions/projection/session-lookups.js";

/**
 * The composer purger the workflows now require (`purgeSlot` is a published
 * command, not an optional). These cases are about the catalog, so the purger is a
 * no-op.
 */
const purger = () => createWebuiSessionComposerAccess({ purgeSlot: () => undefined });

function session(
  over: Partial<WebuiClientSession> & { sessionId: string },
): WebuiClientSession {
  return {
    agentName: "main",
    createdAt: 1,
    updatedAt: 100,
    ...over,
  };
}

describe("session entity catalog", () => {
  it("flat and tree resolve from one entity map", () => {
    let catalog = reduceWebuiCatalogFlatLoaded(initialWebuiSessionCatalogState, {
      sessions: [session({ sessionId: "a", title: "A" })],
      hasMore: false,
    });
    catalog = reduceWebuiCatalogTreeLoaded(catalog, {
      sessions: [
        {
          session: session({ sessionId: "a", title: "A" }),
          childSessions: [session({ sessionId: "c", parentSessionId: "a" })],
        },
      ],
      hasMore: false,
    });

    const flat = selectWebuiCatalogFlatPage(catalog);
    const tree = selectWebuiCatalogTreePage(catalog);
    // The flat page's entity and the tree node's root are the *same object*:
    // they are one catalog entity, not two copies kept in step by hand.
    expect(flat.sessions[0]).toBe(tree.sessions[0]?.session);
    expect(tree.sessions[0]?.childSessions.map((c) => c.sessionId)).toEqual(["c"]);
  });

  it("patches one entity and every view agrees", () => {
    let catalog = reduceWebuiCatalogFlatLoaded(initialWebuiSessionCatalogState, {
      sessions: [session({ sessionId: "a", title: "old" })],
      hasMore: false,
    });
    catalog = reduceWebuiCatalogTreeLoaded(catalog, {
      sessions: [
        { session: session({ sessionId: "a", title: "old" }), childSessions: [] },
      ],
      hasMore: false,
    });

    catalog = patchWebuiCatalogEntity(catalog, "a", { title: "new" });

    expect(selectWebuiCatalogFlatPage(catalog).sessions[0]?.title).toBe("new");
    expect(selectWebuiCatalogTreePage(catalog).sessions[0]?.session.title).toBe(
      "new",
    );
  });

  it("keeps flat ids, cursor and appended order", () => {
    let catalog = reduceWebuiCatalogFlatLoaded(initialWebuiSessionCatalogState, {
      sessions: [session({ sessionId: "a" })],
      hasMore: true,
      nextCursor: "cur1",
    });
    catalog = reduceWebuiCatalogFlatAppended(catalog, {
      sessions: [session({ sessionId: "b" })],
      hasMore: false,
    });

    const flat = selectWebuiCatalogFlatPage(catalog);
    expect(flat.sessions.map((s) => s.sessionId)).toEqual(["a", "b"]);
    expect(flat.hasMore).toBe(false);
  });

  it("seeds from a pre-loaded page", () => {
    const catalog = createWebuiSessionCatalogFromPage({
      sessions: [session({ sessionId: "seed" })],
      hasMore: false,
    });
    expect(selectWebuiCatalogFlatPage(catalog).sessions.map((s) => s.sessionId)).toEqual([
      "seed",
    ]);
  });

  it("removes entities a delete confirmed gone", () => {
    const catalog = removeWebuiCatalogEntities(
      createWebuiSessionCatalogFromPage({
        sessions: [session({ sessionId: "a" })],
        hasMore: false,
      }),
      ["a"],
    );
    expect(selectWebuiCatalogFlatPage(catalog).sessions).toEqual([]);
  });
});

describe("session workflows", () => {
  function harness() {
    const calls: string[] = [];
    const store = createWebuiSessionStore();
    const port = {
      loadSessions: async () => {
        calls.push("loadSessions");
        return {
          sessions: [session({ sessionId: "a", title: "loaded" })],
          hasMore: false,
        };
      },
      loadSessionTree: async () => {
        calls.push("loadSessionTree");
        return { sessions: [], hasMore: false };
      },
      updateSession: async (request: { id: string; title?: string }) => {
        calls.push("updateSession");
        return { session: { sessionId: request.id, title: request.title } };
      },
      archiveSession: async () => {
        calls.push("archiveSession");
        return { success: true };
      },
      deleteSession: async () => {
        calls.push("deleteSession");
        return { success: true };
      },
      getSessionForkOptions: async () => {
        calls.push("getSessionForkOptions");
        return { canFork: true, worktreeVisible: true };
      },
      forkSession: async () => {
        calls.push("forkSession");
        return { session: { sessionId: "forked" } };
      },
    };
    const workflows = createWebuiSessionWorkflows({
      store,
      composer: purger(),
      port: port as unknown as Parameters<
        typeof createWebuiSessionWorkflows
      >[0]["port"],
    });
    const flat = () => store.getSnapshot().catalog.flat.ids;
    return { store, workflows, calls, flat };
  }

  it("loads the flat page into the catalog", async () => {
    const { workflows, store, flat } = harness();
    await workflows.loadFlat();
    expect(flat()).toEqual(["a"]);
    expect(store.getSnapshot().catalog.flat.loading).toBe(false);
  });

  it("renames by patching the one entity", async () => {
    const { workflows, store, calls } = harness();
    await workflows.loadFlat();
    await workflows.rename("a", "renamed");
    expect(calls).toContain("updateSession");
    // The one entity the flat and tree views both resolve from carries the new
    // title; no second structure was touched.
    expect(
      selectWebuiCatalogFlatPage(store.getSnapshot().catalog).sessions[0]?.title,
    ).toBe("renamed");
  });

  it("removes the entity after a successful delete", async () => {
    const store = createWebuiSessionStore({
      catalog: createWebuiSessionCatalogFromPage({
        sessions: [session({ sessionId: "a" })],
        hasMore: false,
      }),
    });
    const workflows = createWebuiSessionWorkflows({
      store,
      composer: purger(),
      port: {
        deleteSession: async () => ({ success: true }),
        loadSessions: async () => ({ sessions: [], hasMore: false }),
        loadSessionTree: async () => ({ sessions: [], hasMore: false }),
      } as unknown as Parameters<typeof createWebuiSessionWorkflows>[0]["port"],
    });
    await workflows.remove("a");
    expect(store.getSnapshot().catalog.flat.ids).toEqual([]);
  });

  it("gates a fork on the reported options", async () => {
    const store = createWebuiSessionStore();
    const workflows = createWebuiSessionWorkflows({
      store,
      composer: purger(),
      port: {
        getSessionForkOptions: async () => ({ canFork: false, unavailableReason: "no boundary" }),
        forkSession: async () => ({ session: { sessionId: "forked" } }),
      } as unknown as Parameters<typeof createWebuiSessionWorkflows>[0]["port"],
    });
    await expect(workflows.fork("a", false)).rejects.toThrow(
      "当前会话不可复制：no boundary",
    );
  });

  it("fences late project reads and retains the newest committed answer", async () => {
    let resolveFirst: (projects: readonly { name: string; workspaceDir: string }[]) => void = () => {};
    let resolveSecond: (projects: readonly { name: string; workspaceDir: string }[]) => void = () => {};
    let call = 0;
    const workflows = createWebuiSessionWorkflows({
      store: createWebuiSessionStore(),
      composer: purger(),
      port: {
        loadProjects: () => new Promise((resolve) => {
          call += 1;
          if (call === 1) resolveFirst = resolve;
          else resolveSecond = resolve;
        }),
      } as unknown as Parameters<typeof createWebuiSessionWorkflows>[0]["port"],
    });
    const first = workflows.loadProjects();
    const second = workflows.loadProjects();
    const current = [{ name: "current", workspaceDir: "/current" }];
    resolveSecond(current);
    await second;
    resolveFirst([{ name: "stale", workspaceDir: "/stale" }]);
    await first;

    expect(workflows.getProjectsSnapshot()).toEqual({ loading: false, projects: current });
    workflows.dispose();
  });

  it("fences project answers that arrive after workflow disposal", async () => {
    let resolve: (projects: readonly { name: string; workspaceDir: string }[]) => void = () => {};
    const workflows = createWebuiSessionWorkflows({
      store: createWebuiSessionStore(),
      composer: purger(),
      port: {
        loadProjects: () => new Promise((done) => { resolve = done; }),
      } as unknown as Parameters<typeof createWebuiSessionWorkflows>[0]["port"],
    });
    const pending = workflows.loadProjects();
    workflows.dispose();
    resolve([{ name: "late", workspaceDir: "/late" }]);
    await pending;
    expect(workflows.getProjectsSnapshot()).toEqual({ loading: false });
  });

  it("retains project-list failure detail while the session-derived rail remains available", async () => {
    const workflows = createWebuiSessionWorkflows({
      store: createWebuiSessionStore(),
      composer: purger(),
      port: { loadProjects: async () => { throw new Error("project service unavailable"); } } as unknown as Parameters<typeof createWebuiSessionWorkflows>[0]["port"],
    });
    await expect(workflows.loadProjects()).rejects.toThrow("project service unavailable");
    expect(workflows.getProjectsSnapshot()).toEqual({ loading: false, error: "project service unavailable" });
    workflows.dispose();
  });
});

describe("session lookup projection", () => {
  it("merges child records once and resolves agent names by target session", () => {
    const flat = { sessions: [session({ sessionId: "root", agentName: "root-agent" })], hasMore: false };
    const tree = { sessions: [{
      session: flat.sessions[0]!,
      childSessions: [session({ sessionId: "child", parentSessionId: "root", agentName: "child-agent" })],
    }], hasMore: false };
    const lookups = selectWebuiSessionLookups(flat, tree);
    expect(lookups.map((entry) => entry.sessionId)).toEqual(["root", "child"]);
    expect(selectWebuiSessionAgentName(lookups, "root")).toBe("root-agent");
    expect(selectWebuiSessionAgentName(lookups, "child")).toBe("child-agent");
    expect(selectWebuiSessionAgentName(lookups, "missing")).toBe("main");
  });
});

describe("workspace progress selector", () => {
  const state = (
    over: Partial<import("../../src/client/features/workspace/projection/workspace-progress.js").WebuiWorkspaceProgressState>,
  ): import("../../src/client/features/workspace/projection/workspace-progress.js").WebuiWorkspaceProgressState => ({
    todos: [],
    subagents: [],
    hasTodoSnapshot: false,
    hasSubagentSnapshot: false,
    ...over,
  });

  it("lets a live todo snapshot override history — even an empty one", () => {
    const history = state({
      todos: [{ content: "h", status: "pending" }],
      hasTodoSnapshot: true,
    });
    const live = state({ todos: [], hasTodoSnapshot: true });
    expect(selectWebuiWorkspaceProgress({ history, treeSubagents: [], live }).todos).toEqual([]);
  });

  it("falls back to history without a live snapshot", () => {
    const history = state({ todos: [{ content: "h", status: "pending" }] });
    const live = state({ todos: [{ content: "l", status: "pending" }], hasTodoSnapshot: false });
    expect(
      selectWebuiWorkspaceProgress({ history, treeSubagents: [], live }).todos,
    ).toEqual([{ content: "h", status: "pending" }]);
  });

  it("merges subagents history → tree → live, sorted by createdAt", () => {
    const view = selectWebuiWorkspaceProgress({
      history: state({
        subagents: [
          { sessionId: "s", agentName: "h", status: "completed", createdAt: 2 },
        ],
      }),
      treeSubagents: [
        { sessionId: "s", agentName: "t", status: "running", createdAt: 2 },
        { sessionId: "x", agentName: "x", status: "running", createdAt: 1 },
      ],
      live: state({
        subagents: [{ sessionId: "s", agentName: "t", title: "live", status: "completed" }],
      }),
    });
    expect(view.subagents.map((s) => s.sessionId)).toEqual(["x", "s"]);
    // Live wins per field for the session it names.
    expect(view.subagents[1]).toMatchObject({ agentName: "t", title: "live" });
  });
});

describe("the tree ingest reads a node's children defensively", () => {
  /* The wire type says every node carries `childSessions`, but nothing on the
   * wire enforces it: omitting the field when there are no sub-agents is the
   * cheap, natural encoding. Reading it raw used to throw inside this reducer,
   * and `loadTree`'s catch swallowed the throw — so one such node silently
   * emptied the entire tree view. A missing or non-array value must mean "no
   * children", and the rest of the page must still load. */
  it("keeps the node and the rest of the page when childSessions is missing", () => {
    const page = {
      sessions: [
        { session: session({ sessionId: "A" }) },
        { session: session({ sessionId: "B" }), childSessions: [] },
      ],
      hasMore: false,
    } as never;

    const catalog = reduceWebuiCatalogTreeLoaded(initialWebuiSessionCatalogState, page);
    const resolved = selectWebuiCatalogTreePage(catalog);

    expect(resolved.sessions.map((node) => node.session.sessionId)).toEqual(["A", "B"]);
    expect(resolved.sessions[0]?.childSessions).toEqual([]);
  });

  it("treats a non-array childSessions as no children", () => {
    const page = {
      sessions: [{ session: session({ sessionId: "A" }), childSessions: {} }],
      hasMore: false,
    } as never;

    const catalog = reduceWebuiCatalogTreeLoaded(initialWebuiSessionCatalogState, page);
    expect(selectWebuiCatalogTreePage(catalog).sessions[0]?.childSessions).toEqual([]);
  });

  it("still projects real children and their ids", () => {
    const page = {
      sessions: [
        {
          session: session({ sessionId: "A" }),
          childSessions: [session({ sessionId: "A1" }), session({ sessionId: "A2" })],
        },
      ],
      hasMore: false,
    } as never;

    const catalog = reduceWebuiCatalogTreeLoaded(initialWebuiSessionCatalogState, page);
    const resolved = selectWebuiCatalogTreePage(catalog);
    expect(resolved.sessions[0]?.childSessions.map((child) => child.sessionId)).toEqual(["A1", "A2"]);
  });
});

// A delete is an accepted mutation, so it holds a settlement lease until its
// outcome and invalidation are committed, and revokes the deleted session's
// remaining interests at the commit point.
describe("the session scope across a delete", () => {
  function deletingWorkflows(deleteSession: () => Promise<{ success?: boolean }>) {
    const store = createWebuiSessionStore({
      catalog: createWebuiSessionCatalogFromPage({
        sessions: [session({ sessionId: "a" })],
        hasMore: false,
      }),
    });
    const scope = createWebuiSessionScopeManager();
    const workflows = createWebuiSessionWorkflows({
      store,
      composer: purger(),
      scope,
      port: {
        deleteSession,
        loadSessions: async () => ({ sessions: [], hasMore: false }),
        loadSessionTree: async () => ({ sessions: [], hasMore: false }),
      } as unknown as Parameters<typeof createWebuiSessionWorkflows>[0]["port"],
    });
    return { store, scope, workflows };
  }

  it("holds a settlement lease while the delete is in flight, and drops it at the commit", async () => {
    let commit!: () => void;
    const pending = new Promise<{ success?: boolean }>((resolve) => {
      commit = () => resolve({ success: true });
    });
    const { scope, workflows } = deletingWorkflows(() => pending);

    const removal = workflows.remove("a");
    await Promise.resolve();

    // Nothing may evict the session while the mutation it owes is in flight.
    expect(scope.kinds("a")).toEqual(["settlement"]);
    expect(scope.mayEvict("a")).toBe(false);

    commit();
    await removal;
    expect(scope.isInterested("a")).toBe(false);
  });

  it("revokes every browser interest in the deleted session", async () => {
    const { scope, workflows } = deletingWorkflows(async () => ({ success: true }));
    // A stream attempt on the session being deleted: it can no longer commit, so
    // its lease must not keep the session interesting.
    scope.acquire("a", "delivery", "attempt-1");
    scope.acquire("a", "secondary", "workspace-tab-1");

    await workflows.remove("a");

    expect(scope.isInterested("a")).toBe(false);
    expect(scope.interested()).toEqual([]);
  });

  it("releases the lease and keeps the session when the delete fails", async () => {
    const { scope, workflows } = deletingWorkflows(async () => {
      throw new Error("delete refused");
    });
    scope.acquire("a", "delivery", "attempt-1");

    await expect(workflows.remove("a")).rejects.toThrow("delete refused");

    // The failure is recorded, the settlement lease is gone, and what the
    // session owed before the attempt is untouched.
    expect(scope.kinds("a")).toEqual(["delivery"]);
    expect(scope.isInterested("a")).toBe(true);
  });
});
