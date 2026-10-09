// The session entity catalog and the session workflows (plan §7.1, §7.6;
// ticket #49 corrections 1 and 2).
//
// These are the deterministic application tests for the ownership correction:
// flat and tree resolve from one entity map (so a rename cannot leave two
// copies disagreeing), and the loads/mutations run through the workflow
// surface against a scripted port.

import { describe, expect, it } from "vitest";

import {
  createWebuiSessionCatalogFromPage,
  initialWebuiSessionCatalogState,
  patchWebuiCatalogEntity,
  reduceWebuiCatalogFlatAppended,
  reduceWebuiCatalogFlatLoaded,
  reduceWebuiCatalogTreeLoaded,
  removeWebuiCatalogEntities,
  selectWebuiCatalogFlatPage,
  selectWebuiCatalogTreePage,
} from "../../src/client/application/session-catalog.js";
import { createWebuiSessionStore } from "../../src/client/application/session-store.js";
import { createWebuiSessionWorkflows } from "../../src/client/application/session-workflows.js";
import { selectWebuiWorkspaceProgress } from "../../src/client/projection/workspace-progress.js";
import type { WebuiClientSession } from "../../src/client/contracts/session-view.js";

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
      port: {
        getSessionForkOptions: async () => ({ canFork: false, unavailableReason: "no boundary" }),
        forkSession: async () => ({ session: { sessionId: "forked" } }),
      } as unknown as Parameters<typeof createWebuiSessionWorkflows>[0]["port"],
    });
    await expect(workflows.fork("a", false)).rejects.toThrow(
      "当前会话不可复制：no boundary",
    );
  });
});

describe("workspace progress selector", () => {
  const state = (
    over: Partial<import("../../src/client/projection/workspace-progress.js").WebuiWorkspaceProgressState>,
  ): import("../../src/client/projection/workspace-progress.js").WebuiWorkspaceProgressState => ({
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
