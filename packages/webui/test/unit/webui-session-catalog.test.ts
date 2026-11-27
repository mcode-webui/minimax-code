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
import type { WebuiClientProject, WebuiClientSession } from "../../src/client/features/sessions/contracts/session-view.js";
import type { WebuiSessionLookupResult } from "../../src/shared/contracts/session.js";
import { selectWebuiSessionAgentName, selectWebuiSessionLookups } from "../../src/client/features/sessions/projection/session-lookups.js";

/**
 * The composer purger the workflows now require (`purgeSlot` is a published
 * command, not an optional). These cases are about the catalog, so the purger is a
 * no-op.
 */
const purger = () => createWebuiSessionComposerAccess({ purgeSlot: () => undefined });

describe("B21 catalog query ordering", () => {
  it("coalesces created facts and does not restart dirty initial reads after disposal", async () => {
    const store = createWebuiSessionStore();
    const pending = pendingPage(); let calls = 0;
    const workflows = createWebuiSessionWorkflows({ store, composer: purger(), port: {
      loadSessions: () => { calls += 1; return pending.promise; },
    } as unknown as Parameters<typeof createWebuiSessionWorkflows>[0]["port"] });
    const initial = workflows.loadFlat();
    for (let i = 0; i < 20; i += 1) workflows.applyFact({ kind: "created", sessionId: "A" });
    expect(calls).toBe(1);
    workflows.dispose(); pending.resolve({ sessions: [], hasMore: false }); await initial;
    expect(calls).toBe(1);
  });
  it("does not let an invalidated older initial read restart over a newer explicit read", async () => {
    const store = createWebuiSessionStore(); const pending = pendingPage(); let calls = 0;
    const current = session({ sessionId: "A", title: "new" });
    const workflows = createWebuiSessionWorkflows({ store, composer: purger(), port: {
      loadSessions: () => ++calls === 1 ? pending.promise : Promise.resolve({ sessions: [current], hasMore: false }),
    } as unknown as Parameters<typeof createWebuiSessionWorkflows>[0]["port"] });
    const first = workflows.loadFlat(); workflows.applyFact({ kind: "renamed", sessionId: "A", title: "new" });
    await workflows.loadFlat(); pending.resolve({ sessions: [], hasMore: false }); await first;
    expect(store.getSnapshot().catalog.flat.ids).toEqual(["A"]); expect(calls).toBe(2);
  });
  it("reconciles failed dirty initial requests and retains the next-page cursor on replacement", async () => {
    const store = createWebuiSessionStore();
    const current = session({ sessionId: "A", title: "new" });
    let reject!: (reason: unknown) => void;
    const failed = new Promise<never>((_, fail) => { reject = fail; });
    const cursors: Array<string | undefined> = [];
    const workflows = createWebuiSessionWorkflows({ store, composer: purger(), port: {
      loadSessions: (cursor?: string) => { cursors.push(cursor); return cursors.length === 1 ? failed
        : Promise.resolve({ sessions: [current], hasMore: false }); },
    } as unknown as Parameters<typeof createWebuiSessionWorkflows>[0]["port"] });
    const read = workflows.loadMore("next-page");
    workflows.applyFact({ kind: "renamed", sessionId: "A", title: "new" });
    reject(new Error("obsolete initial failure")); await read;
    expect(cursors).toEqual(["next-page", "next-page"]);
    expect(store.getSnapshot().catalog.flat.ids).toEqual(["A"]);
    expect(store.getSnapshot().catalog.flat.error).toBeUndefined();
    expect(store.getSnapshot().catalog.flat.loading).toBe(false);
  });
  it.each(["renamed", "pinned", "visibility"] as const)("reconciles initial flat/tree membership after an unknown %s fact without a refresh storm", async (kind) => {
    const store = createWebuiSessionStore();
    const flat = pendingPage(); const replacementFlat = pendingPage();
    const tree = pendingPage(); const replacementTree = pendingPage();
    let flatCalls = 0; let treeCalls = 0;
    const workflows = createWebuiSessionWorkflows({ store, composer: purger(), port: {
      loadSessions: () => ++flatCalls === 1 ? flat.promise : replacementFlat.promise,
      loadSessionTree: async () => {
        const page = await (++treeCalls === 1 ? tree.promise : replacementTree.promise);
        return { ...page, sessions: page.sessions.map((s) => ({ session: s, childSessions: [] })) };
      },
    } as unknown as Parameters<typeof createWebuiSessionWorkflows>[0]["port"] });
    const firstFlat = workflows.loadFlat(); const firstTree = workflows.loadTree();
    for (let i = 0; i < 20; i += 1) workflows.applyFact(kind === "renamed"
      ? { kind, sessionId: "A", title: "new" }
      : kind === "visibility" ? { kind, sessionId: "A", hidden: true }
      : { kind, sessionId: "A", pinned: true });
    expect(flatCalls).toBe(1); expect(treeCalls).toBe(1);
    expect(store.getSnapshot().catalog.entities.size).toBe(0);
    const old = session({ sessionId: "A", title: "old" });
    flat.resolve({ sessions: [old], hasMore: false }); tree.resolve({ sessions: [old], hasMore: false });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(flatCalls).toBe(2); expect(treeCalls).toBe(2);
    expect(store.getSnapshot().catalog.flat.loading).toBe(true);
    const current = kind === "visibility" ? [] : [{ ...old, title: "new" }];
    replacementFlat.resolve({ sessions: current, hasMore: false });
    replacementTree.resolve({ sessions: current, hasMore: false });
    await Promise.all([firstFlat, firstTree]);
    expect(store.getSnapshot().catalog.flat.ids).toEqual(current.map((s) => s.sessionId));
    expect(store.getSnapshot().catalog.tree.nodes.map((n) => n.sessionId)).toEqual(current.map((s) => s.sessionId));
    expect(store.getSnapshot().catalog.flat.loading).toBe(false);
    expect(flatCalls).toBe(2); expect(treeCalls).toBe(2);
  });
  it("reconciles known non-created facts during initial tree load and preserves both memberships", async () => {
    const store = createWebuiSessionStore();
    const original = session({ sessionId: "A", title: "old" });
    store.updateCatalog(() => createWebuiSessionCatalogFromPage({ sessions: [original], hasMore: false }));
    const pending = pendingPage(); let flatCalls = 0; let treeCalls = 0;
    const current = [ { ...original, title: "new" }, session({ sessionId: "B", title: "second" }) ];
    const workflows = createWebuiSessionWorkflows({ store, composer: purger(), port: {
      loadSessions: () => ++flatCalls === 1 ? pending.promise : Promise.resolve({ sessions: current, hasMore: false }),
      loadSessionTree: async () => {
        const page = ++treeCalls === 1 ? await pending.promise : { sessions: current, hasMore: false };
        return { ...page, sessions: page.sessions.map((s) => ({ session: s, childSessions: [] })) };
      },
    } as unknown as Parameters<typeof createWebuiSessionWorkflows>[0]["port"] });
    const reads = workflows.refresh();
    workflows.applyFact({ kind: "renamed", sessionId: "A", title: "new" });
    expect(store.getSnapshot().catalog.flat.ids).toEqual(["A"]);
    pending.resolve({ sessions: [original], hasMore: false }); await reads;
    expect(store.getSnapshot().catalog.flat.ids).toEqual(["A", "B"]);
    expect(store.getSnapshot().catalog.tree.nodes.map((n) => n.sessionId)).toEqual(["A", "B"]);
    expect(store.getSnapshot().catalog.entities.get("A")?.title).toBe("new");
    expect([flatCalls, treeCalls]).toEqual([2, 2]);
  });
  it("preserves refresh failure reporting while exposing the flat query error", async () => {
    const store = createWebuiSessionStore();
    const workflows = createWebuiSessionWorkflows({ store, composer: purger(), port: {
      loadSessions: async () => { throw new Error("catalog unavailable"); },
    } as unknown as Parameters<typeof createWebuiSessionWorkflows>[0]["port"] });
    await expect(workflows.refresh()).rejects.toThrow("catalog unavailable");
    expect(store.getSnapshot().catalog.flat.error).toBe("catalog unavailable");
    expect(store.getSnapshot().catalog.flat.loading).toBe(false);
  });
  function pendingPage() {
    let resolve!: (page: { sessions: WebuiClientSession[]; hasMore: boolean }) => void;
    const promise = new Promise<{ sessions: WebuiClientSession[]; hasMore: boolean }>((res) => { resolve = res; });
    return { promise, resolve };
  }
  it("keeps newer entity facts when flat and tree queries answer in reverse order", async () => {
    const store = createWebuiSessionStore();
    const first = pendingPage();
    const original = session({ sessionId: "A", title: "old" });
    const workflows = createWebuiSessionWorkflows({ store, composer: purger(), port: {
      loadSessions: () => first.promise,
      loadSessionTree: async () => ({ sessions: [{ session: { ...original, title: "new" }, childSessions: [] }], hasMore: false }),
    } as unknown as Parameters<typeof createWebuiSessionWorkflows>[0]["port"] });
    const oldFlat = workflows.loadFlat(); await workflows.loadTree();
    first.resolve({ sessions: [original], hasMore: false }); await oldFlat;
    expect(selectWebuiCatalogFlatPage(store.getSnapshot().catalog).sessions[0]?.title).toBe("new");
    expect(selectWebuiCatalogTreePage(store.getSnapshot().catalog).sessions[0]?.session.title).toBe("new");
  });
  it.each(["tree", "more", "refresh"])("fences the %s path against an authoritative rename", async (path) => {
    const store = createWebuiSessionStore();
    const original = session({ sessionId: "A", title: "old" });
    store.updateCatalog(() => createWebuiSessionCatalogFromPage({ sessions: [original], hasMore: false }));
    const page = pendingPage();
    let flatReads = 0; let treeReads = 0;
    const workflows = createWebuiSessionWorkflows({ store, composer: purger(), port: {
      loadSessions: () => ++flatReads === 1 ? page.promise : Promise.resolve({ sessions: path === "more" ? [] : [{ ...original, title: "new" }], hasMore: false }),
      loadSessionTree: async () => { const value = ++treeReads === 1 ? await page.promise : { sessions: [{ ...original, title: "new" }], hasMore: false }; return { ...value, sessions: value.sessions.map((s) => ({ session: s, childSessions: [] })) }; },
      updateSession: async () => ({ session: { ...original, title: "new" } }),
    } as unknown as Parameters<typeof createWebuiSessionWorkflows>[0]["port"] });
    const read = path === "tree" ? workflows.loadTree() : path === "more" ? workflows.loadMore("next") : workflows.refresh();
    await workflows.rename("A", "new");
    page.resolve({ sessions: [original], hasMore: false }); await read;
    expect(store.getSnapshot().catalog.entities.get("A")?.title).toBe("new");
    expect(store.getSnapshot().catalog.flat.ids).toEqual(["A"]);
  });
  it.each(["rename", "event", "new read", "hide"])("an older read cannot undo %s", async (action) => {
    const store = createWebuiSessionStore();
    const original = session({ sessionId: "A", title: "old" });
    store.updateCatalog(() => createWebuiSessionCatalogFromPage({ sessions: [original], hasMore: false }));
    const first = pendingPage(); const second = pendingPage(); let reads = 0;
    const workflows = createWebuiSessionWorkflows({ store, composer: purger(), port: {
      loadSessions: () => ++reads === 1 ? first.promise : action === "new read" ? second.promise
        : Promise.resolve({ sessions: action === "hide" ? [] : [{ ...original, title: "new" }], hasMore: false }),
      updateSession: async () => ({ session: { ...original, title: "new" } }),
    } as unknown as Parameters<typeof createWebuiSessionWorkflows>[0]["port"] });
    const oldRead = workflows.loadFlat();
    if (action === "rename") await workflows.rename("A", "new");
    if (action === "event") workflows.applyFact({ kind: "renamed", sessionId: "A", title: "new" });
    if (action === "hide") workflows.applyFact({ kind: "visibility", sessionId: "A", hidden: true });
    if (action === "new read") { const newer = workflows.loadFlat(); second.resolve({ sessions: [{ ...original, title: "new" }], hasMore: false }); await newer; }
    first.resolve({ sessions: [original], hasMore: true }); await oldRead;
    expect(store.getSnapshot().catalog.flat.loading).toBe(false);
    if (action === "hide") expect(store.getSnapshot().catalog.flat.ids).toEqual([]);
    else expect(store.getSnapshot().catalog.entities.get("A")?.title).toBe("new");
    workflows.setError("read failed"); workflows.setError(undefined);
    expect(store.getSnapshot().catalog.flat.error).toBeUndefined();
  });
});

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

  it("reads project membership after creation and reconciles creations during a pending read", async () => {
    const reads: Array<(rows: readonly WebuiClientProject[]) => void> = [];
    const workflows = createWebuiSessionWorkflows({
      store: createWebuiSessionStore(), composer: purger(), port: {
        loadProjects: () => new Promise<readonly WebuiClientProject[]>((resolve) => { reads.push(resolve); }),
      } as Parameters<typeof createWebuiSessionWorkflows>[0]["port"],
    });
    const expected: WebuiClientProject = {
      projectId: 2, workspaceDir: "/later", projectKind: "workspace", hidden: false, pinned: false,
      orderIndex: 0, recentAtMs: 1, latestActivityAtMs: 1, sessionCount: 1,
    };
    const initial = workflows.loadProjects();
    reads[0]!([]);
    await initial;
    workflows.applyFact({ kind: "created", sessionId: "first" });
    workflows.applyFact({ kind: "created", sessionId: "second" });
    workflows.applyFact({ kind: "created", sessionId: "third" });
    expect(reads).toHaveLength(2);
    reads[1]!([]);
    await Promise.resolve();
    expect(reads).toHaveLength(3);
    expect(workflows.getProjectsSnapshot().loading).toBe(true);
    reads[2]!([expected]);
    await Promise.resolve();
    expect(workflows.getProjectsSnapshot()).toEqual({ loading: false, projects: [expected] });
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
  it("coalesces a direct session lookup without changing query pages or navigation", async () => {
    const store = createWebuiSessionStore();
    let finish!: (value: WebuiSessionLookupResult) => void;
    let calls = 0;
    const workflows = createWebuiSessionWorkflows({ store, composer: purger(), port: {
      getSession: () => { calls += 1; return new Promise((resolve) => { finish = resolve; }); },
    } as Parameters<typeof createWebuiSessionWorkflows>[0]["port"] });
    const first = workflows.acquireSession("direct");
    expect(workflows.acquireSession("direct")).toBe(first);
    store.select("another");
    finish({ session: { ...session({ sessionId: "direct", workspaceDir: "/direct" }) } });
    await first;
    expect(calls).toBe(1);
    expect(store.getSnapshot().catalog.entities.get("direct")?.workspaceDir).toBe("/direct");
    expect(store.getSnapshot().catalog.flat.ids).toEqual([]);
    expect(store.getSelectedSessionId()).toBe("another");
    workflows.dispose();
  });

  it.each(["delete", "dispose"])("fences direct metadata after %s", async (mode) => {
    const store = createWebuiSessionStore();
    let finish!: (value: WebuiSessionLookupResult) => void;
    const workflows = createWebuiSessionWorkflows({ store, composer: purger(), port: {
      getSession: () => new Promise((resolve) => { finish = resolve; }),
      deleteSession: async () => ({ success: true }),
    } as Parameters<typeof createWebuiSessionWorkflows>[0]["port"] });
    const reading = workflows.acquireSession("direct");
    if (mode === "delete") await workflows.remove("direct");
    else workflows.dispose();
    finish({ session: { ...session({ sessionId: "direct" }) } });
    await reading;
    expect(store.getSnapshot().catalog.entities.has("direct")).toBe(false);
    workflows.dispose();
  });

  it("rejects mismatched direct metadata without fabricating a catalogue entity", async () => {
    const store = createWebuiSessionStore();
    const workflows = createWebuiSessionWorkflows({ store, composer: purger(), port: {
      getSession: async () => ({ session: { ...session({ sessionId: "wrong" }) } }),
    } as Parameters<typeof createWebuiSessionWorkflows>[0]["port"] });
    await expect(workflows.acquireSession("direct")).rejects.toThrow("incomplete or mismatched identity metadata");
    expect(store.getSnapshot().catalog.entities.size).toBe(0);
    workflows.dispose();
  });

  it("reloads the catalogue when another client creates an unknown session", async () => {
    const store = createWebuiSessionStore();
    let reads = 0;
    const added = session({ sessionId: "external-new" });
    const workflows = createWebuiSessionWorkflows({ store, composer: purger(), port: {
      loadSessions: async () => { reads += 1; return { sessions: [added], hasMore: false }; },
    } as unknown as Parameters<typeof createWebuiSessionWorkflows>[0]["port"] });
    workflows.applyFact({ kind: "created", sessionId: added.sessionId });
    await expect.poll(() => reads).toBe(1);
    expect(store.getSnapshot().catalog.entities.get(added.sessionId)).toEqual(added);
    workflows.dispose();
  });

  it("resolves a tree root absent from the current flat page", () => {
    const root = session({ sessionId: "tree-only", agentName: "tree-agent", workspaceDir: "/tree-workspace" });
    const lookups = selectWebuiSessionLookups({ sessions: [], hasMore: true }, {
      sessions: [{ session: root, childSessions: [] }], hasMore: false,
    });
    expect(lookups).toEqual([root]);
    expect(selectWebuiSessionAgentName(lookups, "tree-only")).toBe("tree-agent");
  });

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
