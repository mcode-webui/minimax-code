// Write authority on the session slices, and the delete teardown.
//
// Two findings are pinned here.
//
//   1. **A renamed setter is not a narrowed capability.** The application
//      command surface used to hand components `updateStream((current) => next)`
//      plus `updatePermissions` / `updateQuestionnaire`, so a component could
//      rewrite any field of the slice and walk around the generation fence the
//      owner applies. The un-narrowed updaters are gone, and so is the sink
//      factory: the lease is minted inside the binding that owns the store
//      writer, which composes it into the attach/send intents a component
//      submits.
//
//   2. **A delete left state behind.** Removing a session dropped its catalog
//      entity and nothing else: the session record, its activity entry (busy
//      hint and last activity time) and the composer slot's draft and history all
//      survived, and a load already in flight could put the entity straight
//      back. `purgeSession` / `purgeSlot` and the workflow's delete fence close
//      that hole.
//
// The suites drive the application modules directly — the webui suite has no
// DOM — against scripted ports and in-memory stores.

import { describe, expect, it, vi } from "vitest";
import { createWebuiSessionComposerAccess } from "../../src/client/features/sessions/application/session-workflows.js";

import { createWebuiSessionCatalogFromPage, reduceWebuiCatalogFlatLoaded, removeWebuiCatalogSessions } from "../../src/client/features/sessions/application/session-catalog.js";
import { initialWebuiSessionCatalogState, selectWebuiCatalogFlatPage } from "../../src/client/features/sessions/application/session-catalog.public.js";
import { createWebuiSessionStore } from "../../src/client/application/session-store.js";
import { createWebuiSessionScopeManager } from "../../src/client/conversation/session-scope.js";
import {
  createWebuiSessionWorkflows,
} from "../../src/client/features/sessions/application/session-workflows.js";
import { createWebuiComposerStore } from "../../src/client/features/composer/application/composer-store.js";
import { createWebuiInteractionCommands } from "../../src/client/features/sessions/application/session-commands.js";
import { createWebuiTurnCommands } from "../../src/client/features/turn/application/turn-command-writer.js";
import { createWebuiTurnLifecycleCommands } from "../../src/client/features/turn/application/turn-lifecycle-commands.js";
import { WEBUI_HOME_SESSION_KEY } from "../../src/client/application/state.js";
import {
  initialWebuiStreamState,
  type WebuiStreamState,
} from "../../src/client/features/turn/projection/stream-state.js";
import type { WebuiStreamLoopExtra } from "../../src/client/features/turn/contracts/stream-loop.js";
import { buildWebuiStreamLoopSink } from "../../src/client/features/turn/application/stream-loop-sink.js";
import { streamStateBundle } from "../../src/client/features/turn/application/stream-state-bundle.js";
import type { WebuiSessionActivityMap } from "../../src/client/features/sessions/projection/session-activity.js";
import type { WebuiClientSession } from "../../src/client/features/sessions/contracts/session-view.js";
import type { WebuiSessionListItem } from "../../src/shared/contracts/session.js";
import type { WebuiStreamFrame } from "../../src/shared/contracts/stream.js";

/**
 * A purger spy for the cases whose subject is something else. The dependency is
 * required, so every construction supplies one; the cases below assert the
 * *other* teardown effects.
 */
const purger = () => createWebuiSessionComposerAccess({ purgeSlot: vi.fn() });

function session(over: Partial<WebuiClientSession> & { sessionId: string }): WebuiClientSession {
  return { agentName: "main", createdAt: 1, updatedAt: 100, ...over };
}

function page(...ids: string[]) {
  return { sessions: ids.map((sessionId) => session({ sessionId })), hasMore: false };
}

/** A recording cell behind a store-shaped stream writer. */
function streamCell() {
  let state: WebuiStreamState = initialWebuiStreamState;
  const setStream = (
    update: (current: WebuiStreamState) => WebuiStreamState,
  ): void => {
    state = update(state);
  };
  return { setStream, get: () => state };
}

/**
 * The attempt's sink, built the way its owner builds it. The command surface no
 * longer hands one out — minting a lease is the binding's job, not a component's
 * — so the lease tests drive the mechanism over the same `setStream`.
 */
function openSink(cell: ReturnType<typeof streamCell>) {
  return buildWebuiStreamLoopSink(cell.setStream, streamStateBundle);
}

const frame: WebuiStreamFrame = {
  dataJson: '{"type":2,"agent_message":{"msg_id":"m1","msg_content":"x"}}',
};

describe("R7 · the session store's purge", () => {
  it("drops the session record and its activity entry, and notifies once", () => {
    const store = createWebuiSessionStore();
    store.updateSession("s1", (current) => ({ ...current, sending: true }));
    store.updateActivity((current): WebuiSessionActivityMap => ({
      ...current,
      s1: { lastActivityAt: 5 },
    }));
    const listener = vi.fn();
    store.subscribe(listener);

    store.purgeSession("s1");

    const snapshot = store.getSnapshot();
    expect(snapshot.sessions.has("s1")).toBe(false);
    expect(snapshot.activity.s1).toBeUndefined();
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("is idempotent: a second purge has nothing left to drop and emits nothing", () => {
    const store = createWebuiSessionStore();
    store.updateSession("s1", (current) => ({ ...current, sending: true }));
    store.updateActivity((current): WebuiSessionActivityMap => ({
      ...current,
      s1: { lastActivityAt: 5 },
    }));
    store.purgeSession("s1");
    const listener = vi.fn();
    store.subscribe(listener);

    store.purgeSession("s1");

    expect(listener).not.toHaveBeenCalled();
    expect(store.getSnapshot().sessions.has("s1")).toBe(false);
  });

  it("fences late completions: a write that lands after the delete writes nothing", () => {
    const store = createWebuiSessionStore();
    store.updateSession("s1", (current) => ({ ...current, sending: true }));
    store.purgeSession("s1");
    const listener = vi.fn();
    store.subscribe(listener);

    // A stream frame or event that read the store before the delete, and
    // commits after it, must not resurrect the record…
    store.updateSession("s1", (current) => ({ ...current, sending: true }));
    const writer = store.createSessionWriter({ kind: "session", sessionId: "s1" });
    writer.setSending(true);
    writer.setStream((current) => ({ ...current, phase: "streaming" }));
    // …and it must not resurrect the badge or the busy hint either: the
    // activity slice carries its own filter.
    store.updateActivity((current): WebuiSessionActivityMap => ({
      ...current,
      s1: { lastActivityAt: 9, busy: { turnId: "t1", busyReason: "turn" } },
    }));

    const snapshot = store.getSnapshot();
    expect(snapshot.sessions.has("s1")).toBe(false);
    expect(snapshot.activity.s1).toBeUndefined();
    expect(listener).not.toHaveBeenCalled();
  });

  it("is a no-op after dispose", () => {
    const store = createWebuiSessionStore();
    store.updateSession("s1", (current) => ({ ...current, sending: true }));
    store.dispose();
    store.purgeSession("s1");
    expect(store.getSnapshot().sessions.has("s1")).toBe(true);
  });

  it("never purges the home slot, which is not a server session", () => {
    const store = createWebuiSessionStore();
    store.updateSession(WEBUI_HOME_SESSION_KEY, (current) => ({
      ...current,
      sending: true,
    }));
    store.purgeSession(WEBUI_HOME_SESSION_KEY);
    expect(store.getSnapshot().sessions.has(WEBUI_HOME_SESSION_KEY)).toBe(true);
  });

  it("refuses to migrate a record onto a purged session id", () => {
    // The home→session adoption runs on its own schedule, so the session it
    // names can already be deleted when the migration lands. Carrying the
    // record onto that key would resurrect a session the store has purged.
    const store = createWebuiSessionStore();
    store.updateSession(WEBUI_HOME_SESSION_KEY, (current) => ({
      ...current,
      sending: true,
    }));
    store.purgeSession("deleted");
    const before = store.readSession(WEBUI_HOME_SESSION_KEY);

    store.migrateSession(WEBUI_HOME_SESSION_KEY, "deleted");

    // The purged key stays empty: it reads exactly like a key that was never
    // written. (`migrateSession` does not notify, so the record is read off the
    // live map rather than the last published snapshot.)
    expect(store.readSession("deleted")).toEqual(store.readSession("never-written"));
    // A refused migration leaves the source record where it was: the caller
    // that is about to switch keys still owns it, and losing it would strand
    // the in-flight home turn.
    expect(store.readSession(WEBUI_HOME_SESSION_KEY)).toBe(before);
  });

  it("still migrates onto a live session id", () => {
    const store = createWebuiSessionStore();
    store.updateSession(WEBUI_HOME_SESSION_KEY, (current) => ({
      ...current,
      sending: true,
    }));
    const before = store.readSession(WEBUI_HOME_SESSION_KEY);

    store.migrateSession(WEBUI_HOME_SESSION_KEY, "live");

    expect(store.readSession("live")).toBe(before);
    expect(store.readSession(WEBUI_HOME_SESSION_KEY)).toEqual(
      store.readSession("never-written"),
    );
  });
});

describe("R7 · the composer store's purgeSlot", () => {
  function composerHarness() {
    const saveComposer = vi.fn();
    const store = createWebuiComposerStore({
      initial: { drafts: { a: "keep writing", b: "other" }, history: { a: ["first"], b: ["x"] } },
      storage: { loadComposer: (parse) => parse(undefined), saveComposer },
    });
    return { store, saveComposer };
  }

  it("drops the slot's draft and history, notifies and persists", () => {
    const { store, saveComposer } = composerHarness();
    const listener = vi.fn();
    store.subscribe(listener);

    store.purgeSlot("a");

    expect(store.readDraft("a")).toBe("");
    expect(store.readHistory("a")).toEqual([]);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(saveComposer).toHaveBeenCalledTimes(1);
    // The persisted state no longer carries the slot, and the purge passes no
    // keep key — a deleted slot has nothing for the prune to protect.
    expect(saveComposer.mock.calls[0]?.[0]).toEqual({
      drafts: { b: "other" },
      history: { b: ["x"] },
    });
    expect(saveComposer.mock.calls[0]?.[2]).toBeUndefined();
    // Other slots are untouched.
    expect(store.readDraft("b")).toBe("other");
    expect(store.readHistory("b")).toEqual(["x"]);
  });

  it("does nothing when the slot is absent", () => {
    const { store, saveComposer } = composerHarness();
    store.purgeSlot("a");
    saveComposer.mockClear();
    const listener = vi.fn();
    store.subscribe(listener);

    store.purgeSlot("a");

    expect(listener).not.toHaveBeenCalled();
    expect(saveComposer).not.toHaveBeenCalled();
  });
});

describe("R7 · the delete workflow teardown", () => {
  it("purges the record, the activity, the draft and the catalog entity", async () => {
    const store = createWebuiSessionStore({
      catalog: createWebuiSessionCatalogFromPage(page("a", "b")),
    });
    store.updateSession("a", (current) => ({ ...current, sending: true }));
    store.updateActivity((current): WebuiSessionActivityMap => ({
      ...current,
      a: { lastActivityAt: 3 },
    }));
    const composer = createWebuiComposerStore({
      initial: { drafts: { a: "half-written" }, history: { a: ["earlier"] } },
    });
    const workflows = createWebuiSessionWorkflows({
      store,
      composer: createWebuiSessionComposerAccess(composer, { isStagedFor: () => true }),
      port: {
        deleteSession: async () => ({ success: true }),
        loadSessions: async () => page("b"),
        loadSessionTree: async () => ({ sessions: [], hasMore: false }),
      } as unknown as Parameters<typeof createWebuiSessionWorkflows>[0]["port"],
    });

    await workflows.remove("a");

    const snapshot = store.getSnapshot();
    expect(snapshot.sessions.has("a")).toBe(false);
    expect(snapshot.activity.a).toBeUndefined();
    expect(composer.readDraft("a")).toBe("");
    expect(composer.readHistory("a")).toEqual([]);
    expect(snapshot.catalog.entities.has("a")).toBe(false);
    expect(snapshot.catalog.flat.ids).toEqual(["b"]);
  });

  it("keeps every slice when the delete fails, and holds no lease afterwards", async () => {
    const store = createWebuiSessionStore({
      catalog: createWebuiSessionCatalogFromPage(page("a", "b")),
    });
    store.updateSession("a", (current) => ({ ...current, sending: true }));
    store.updateActivity((current): WebuiSessionActivityMap => ({
      ...current,
      a: { lastActivityAt: 3 },
    }));
    const composer = createWebuiComposerStore({
      initial: { drafts: { a: "half-written" }, history: { a: ["earlier"] } },
    });
    const scope = createWebuiSessionScopeManager();
    scope.select("a");
    scope.acquire("a", "delivery", "stream");
    const workflows = createWebuiSessionWorkflows({
      store,
      composer: createWebuiSessionComposerAccess(composer, { isStagedFor: () => true }),
      scope,
      port: {
        deleteSession: async () => {
          throw new Error("delete refused");
        },
        loadSessions: async () => page("b"),
        loadSessionTree: async () => ({ sessions: [], hasMore: false }),
      } as unknown as Parameters<typeof createWebuiSessionWorkflows>[0]["port"],
    });

    await expect(workflows.remove("a")).rejects.toThrow("delete refused");

    // Nothing was purged: a refused delete leaves the session exactly as it was.
    const snapshot = store.getSnapshot();
    expect(snapshot.sessions.get("a")?.sending).toBe(true);
    expect(snapshot.activity.a).toEqual({ lastActivityAt: 3 });
    expect(composer.readDraft("a")).toBe("half-written");
    expect(composer.readHistory("a")).toEqual(["earlier"]);
    expect(snapshot.catalog.entities.has("a")).toBe(true);
    expect(snapshot.catalog.flat.ids).toEqual(["a", "b"]);
    // The settlement lease went with the failure; the selection and the delivery
    // lease were never the delete's to take.
    expect(scope.kinds("a")).toEqual(
      expect.arrayContaining(["selected-view", "delivery"]),
    );
    expect(scope.kinds("a")).not.toContain("settlement");
  });

  it("revokes every interest in the session it deletes", async () => {
    const store = createWebuiSessionStore({
      catalog: createWebuiSessionCatalogFromPage(page("a", "b")),
    });
    const composer = createWebuiComposerStore({ initial: { drafts: {}, history: {} } });
    const scope = createWebuiSessionScopeManager();
    scope.select("a");
    scope.acquire("a", "secondary", "workspace-tab");
    scope.acquire("a", "delivery", "stream");
    const workflows = createWebuiSessionWorkflows({
      store,
      composer: createWebuiSessionComposerAccess(composer, { isStagedFor: () => true }),
      scope,
      port: {
        deleteSession: async () => ({ success: true }),
        loadSessions: async () => page("b"),
        loadSessionTree: async () => ({ sessions: [], hasMore: false }),
      } as unknown as Parameters<typeof createWebuiSessionWorkflows>[0]["port"],
    });

    await workflows.remove("a");

    // The deleted session is no longer interesting to anyone, so nothing can
    // recreate an owner over work the delete already settled.
    expect(scope.isInterested("a")).toBe(false);
    expect(scope.kinds("a")).toEqual([]);
    expect(scope.mayEvict("a")).toBe(true);
    expect(scope.selected()).toBeUndefined();
  });

  it("keeps a deleted session out of a load that lands after the delete", async () => {
    const store = createWebuiSessionStore({
      catalog: createWebuiSessionCatalogFromPage(page("a", "b")),
    });
    let release: (value: ReturnType<typeof page>) => void = () => undefined;
    let calls = 0;
    const loadSessions = () => {
      calls += 1;
      // The first load is the one already in flight when the delete commits.
      return calls === 1
        ? new Promise<ReturnType<typeof page>>((resolve) => {
            release = resolve;
          })
        : Promise.resolve(page("a", "b"));
    };
    const workflows = createWebuiSessionWorkflows({
      store,
      composer: purger(),
      port: {
        deleteSession: async () => ({ success: true }),
        loadSessions,
        loadSessionTree: async () => ({ sessions: [], hasMore: false }),
      } as unknown as Parameters<typeof createWebuiSessionWorkflows>[0]["port"],
    });

    const inFlight = workflows.loadFlat();
    await workflows.remove("a");
    expect(store.getSnapshot().catalog.entities.has("a")).toBe(false);
    expect(store.getSnapshot().catalog.flat.ids).toEqual(["b"]);

    // The stale page still names `a`. Committing it must not put the session
    // back — neither the entity nor the identifier the rail resolves from.
    release(page("a", "b"));
    await inFlight;

    const snapshot = store.getSnapshot();
    expect(snapshot.catalog.entities.has("a")).toBe(false);
    expect(snapshot.catalog.flat.ids).toEqual(["b"]);
    expect(selectWebuiCatalogFlatPage(snapshot.catalog).sessions.map((s) => s.sessionId)).toEqual([
      "b",
    ]);
  });

  it("takes the same teardown when the delete comes from the archived page", async () => {
    const store = createWebuiSessionStore({
      catalog: createWebuiSessionCatalogFromPage(page("a")),
    });
    store.updateSession("a", (current) => ({ ...current, sending: true }));
    const composer = createWebuiComposerStore({ initial: { drafts: { a: "note" }, history: {} } });
    const workflows = createWebuiSessionWorkflows({
      store,
      composer: createWebuiSessionComposerAccess(composer, { isStagedFor: () => true }),
      port: {
        deleteSession: async () => ({ success: true }),
        listArchivedSessions: async () => ({ sessions: [] }),
      } as unknown as Parameters<typeof createWebuiSessionWorkflows>[0]["port"],
    });

    await workflows.removeArchived("a");

    expect(store.getSnapshot().sessions.has("a")).toBe(false);
    expect(store.getSnapshot().catalog.entities.has("a")).toBe(false);
    expect(composer.readDraft("a")).toBe("");
  });
});

describe("R7 · the archived-list delete fence", () => {
  function archivedItem(sessionId: string): WebuiSessionListItem {
    return { sessionId, agentName: "main", createdAt: 1, updatedAt: 100, archived: true };
  }

  function archivedIds(workflows: ReturnType<typeof createWebuiSessionWorkflows>): string[] {
    return workflows.getArchivedSnapshot().sessions.map((session) => session.sessionId);
  }

  it("drops the deleted row while the reload is still in flight", async () => {
    // The reload keeps the current sessions while it is `loading`, so without a
    // commit-time filter the row the user just deleted stays on screen — and
    // stays clickable — until the reply lands.
    const store = createWebuiSessionStore();
    let calls = 0;
    let releaseReload: ((page: { sessions: WebuiSessionListItem[] }) => void) | undefined;
    let reloadStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      reloadStarted = resolve;
    });
    const listArchivedSessions = () => {
      calls += 1;
      if (calls === 1)
        return Promise.resolve({ sessions: [archivedItem("keep"), archivedItem("deleted")] });
      reloadStarted?.();
      return new Promise<{ sessions: WebuiSessionListItem[] }>((resolve) => {
        releaseReload = resolve;
      });
    };
    const workflows = createWebuiSessionWorkflows({
      store,
      composer: purger(),
      port: {
        deleteSession: async () => ({ success: true }),
        listArchivedSessions,
      } as unknown as Parameters<typeof createWebuiSessionWorkflows>[0]["port"],
    });
    await workflows.loadArchived();
    expect(archivedIds(workflows)).toEqual(["keep", "deleted"]);

    const reload = workflows.removeArchived("deleted");
    await started;

    expect(workflows.getArchivedSnapshot().status).toBe("loading");
    expect(archivedIds(workflows)).toEqual(["keep"]);

    // A reply that still names the deleted session cannot bring the row back.
    releaseReload?.({ sessions: [archivedItem("keep"), archivedItem("deleted")] });
    await reload;

    expect(archivedIds(workflows)).toEqual(["keep"]);
  });

  it("keeps a deleted session out of an archived page that lands after the delete", async () => {
    const store = createWebuiSessionStore();
    let release: ((page: { sessions: WebuiSessionListItem[] }) => void) | undefined;
    let calls = 0;
    const listArchivedSessions = () => {
      calls += 1;
      // The first read is the one already in flight when the delete commits.
      return calls === 1
        ? new Promise<{ sessions: WebuiSessionListItem[] }>((resolve) => {
            release = resolve;
          })
        : Promise.resolve({ sessions: [] as WebuiSessionListItem[] });
    };
    const workflows = createWebuiSessionWorkflows({
      store,
      composer: purger(),
      port: {
        deleteSession: async () => ({ success: true }),
        listArchivedSessions,
      } as unknown as Parameters<typeof createWebuiSessionWorkflows>[0]["port"],
    });

    const inFlight = workflows.loadArchived();
    await workflows.removeArchived("deleted");
    expect(archivedIds(workflows)).toEqual([]);
    expect(workflows.getArchivedSnapshot().status).toBe("ready");

    // The stale page still names the deleted session. Committing it must not
    // restore the row — it lost to the newer read, and it also names a session
    // this workflow has deleted.
    release?.({ sessions: [archivedItem("deleted")] });
    await inFlight;

    expect(archivedIds(workflows)).toEqual([]);
    expect(workflows.getArchivedSnapshot().status).toBe("ready");
  });

  it("keeps a deleted session out of a page the server composed before the delete", async () => {
    // This is the half the request version cannot cover: the newest read
    // answers from a list that was already stale when it was produced, so only
    // the delete filter keeps the row out.
    const store = createWebuiSessionStore();
    const workflows = createWebuiSessionWorkflows({
      store,
      composer: purger(),
      port: {
        deleteSession: async () => ({ success: true }),
        listArchivedSessions: async () => ({
          sessions: [archivedItem("keep"), archivedItem("deleted")],
        }),
      } as unknown as Parameters<typeof createWebuiSessionWorkflows>[0]["port"],
    });

    await workflows.loadArchived();
    // Before the delete, both rows are legitimately listed.
    expect(archivedIds(workflows)).toEqual(["keep", "deleted"]);

    await workflows.removeArchived("deleted");

    expect(archivedIds(workflows)).toEqual(["keep"]);
  });

  it("drops a stale archived failure instead of clearing a newer ready list", async () => {
    const store = createWebuiSessionStore();
    let reject: ((error: Error) => void) | undefined;
    let calls = 0;
    const listArchivedSessions = () => {
      calls += 1;
      return calls === 1
        ? new Promise<{ sessions: WebuiSessionListItem[] }>((_resolve, rejectFirst) => {
            reject = rejectFirst;
          })
        : Promise.resolve({ sessions: [archivedItem("keep")] });
    };
    const workflows = createWebuiSessionWorkflows({
      store,
      composer: purger(),
      port: {
        listArchivedSessions,
      } as unknown as Parameters<typeof createWebuiSessionWorkflows>[0]["port"],
    });

    const inFlight = workflows.loadArchived();
    await workflows.loadArchived();
    expect(archivedIds(workflows)).toEqual(["keep"]);

    reject?.(new Error("stale failure"));
    await inFlight;

    expect(workflows.getArchivedSnapshot().status).toBe("ready");
    expect(archivedIds(workflows)).toEqual(["keep"]);
    expect(workflows.getArchivedSnapshot().error).toBeUndefined();
  });
});

describe("R7 · the catalog delete fence", () => {
  it("drops the entity, the flat identifier and the tree node together", () => {
    let catalog = reduceWebuiCatalogFlatLoaded(
      initialWebuiSessionCatalogState,
      page("a", "b"),
    );
    catalog = {
      ...catalog,
      tree: {
        nodes: [
          { sessionId: "a", childIds: ["c"] },
          { sessionId: "b", childIds: [] },
        ],
        hasMore: false,
      },
      entities: new Map(catalog.entities).set("c", session({ sessionId: "c", parentSessionId: "a" })),
    };

    const next = removeWebuiCatalogSessions(catalog, ["a", "c"]);

    expect(next.entities.has("a")).toBe(false);
    expect(next.entities.has("c")).toBe(false);
    expect(next.flat.ids).toEqual(["b"]);
    expect(next.tree.nodes).toEqual([{ sessionId: "b", childIds: [] }]);
  });

  it("returns the same state when there is nothing to drop", () => {
    const catalog = reduceWebuiCatalogFlatLoaded(
      initialWebuiSessionCatalogState,
      page("a"),
    );
    expect(removeWebuiCatalogSessions(catalog, ["zz"])).toBe(catalog);
  });
});

describe("R7 · the command surface carries no raw writer", () => {
  it("offers intents only: no reducer taking stream, permission or questionnaire writer", () => {
    const cell = streamCell();
    const lifecycle = createWebuiTurnLifecycleCommands({
      setStream: cell.setStream,
      setSending: () => undefined,
    });
    const interaction = createWebuiInteractionCommands({
      setPermissions: () => undefined,
      setQuestionnaire: () => undefined,
      setGoal: () => undefined,
    });

    // The three writes the finding named are gone. `updateStream` is the one a
    // component used to reach through four call sites; the two interaction
    // updaters were unreachable but still exported.
    expect(Object.keys(lifecycle)).not.toContain("updateStream");
    expect(Object.keys(interaction)).not.toContain("updatePermissions");
    expect(Object.keys(interaction)).not.toContain("updateQuestionnaire");

    // ...and the lease itself is not on the surface either. A sink factory here
    // let a component mint a fresh generation at will and take the lease from a
    // newer turn; opening a turn's stream now belongs to the binding that owns
    // the store writer.
    expect(Object.keys(lifecycle)).not.toContain("createStreamSink");
    expect(Object.keys(lifecycle)).not.toContain("createSink");
    expect(
      Object.values(lifecycle).filter((value) => typeof value === "function"),
    ).toHaveLength(Object.keys(lifecycle).length);
  });

  it("hands out a sink whose writes the owner fences by generation", () => {
    const cell = streamCell();
    const lifecycle = createWebuiTurnLifecycleCommands({
      setStream: cell.setStream,
      setSending: () => undefined,
    });
    const superseded = openSink(cell);
    const current = openSink(cell);
    // A loop sink always owns the claim; the assertion documents that the
    // fence is part of the sink rather than something the caller adds.
    expect(superseded.claim).toBeDefined();
    expect(current.claim).toBeDefined();
    superseded.claim("local-send");
    current.claim("recovered");

    superseded.accept(frame);
    expect(cell.get().messages).toEqual([]);

    current.accept(frame);
    expect(cell.get().messages.map((message) => message.id)).toEqual(["m1"]);
  });

  it("releases only the named generation, so a stale probe cannot clear a newer lease", () => {
    const cell = streamCell();
    const lifecycle = createWebuiTurnLifecycleCommands({
      setStream: cell.setStream,
      setSending: () => undefined,
    });
    const sink = openSink(cell);
    const generation = sink.claim("local-send");
    expect(cell.get().subscription).toBeDefined();

    lifecycle.releaseStreamSubscription((generation ?? 0) - 1);
    expect(cell.get().subscription).toBeDefined();

    lifecycle.releaseStreamSubscription(generation ?? 0);
    expect(cell.get().subscription).toBeUndefined();
  });

  it("does not let a superseded sink take the lease back by re-claiming", () => {
    const cell = streamCell();
    const lifecycle = createWebuiTurnLifecycleCommands({
      setStream: cell.setStream,
      setSending: () => undefined,
    });
    // Two turns: `stale` opens first, `current` replaces it. That is the normal
    // way a superseded sink ends up alive — the loop for the old turn has not
    // finished when the newer one claims.
    const stale = openSink(cell);
    const staleGeneration = stale.claim("local-send");
    const current = openSink(cell);
    const currentGeneration = current.claim("recovered");
    expect(cell.get().lastClaimedGeneration).toBe(currentGeneration);

    // A second claim must not mint a newer generation. It used to: the sink
    // wrote a fresh number as `lastClaimedGeneration`, made itself the newest
    // claimant again and could then stamp `refused` over the turn that had
    // replaced it.
    expect(stale.claim("local-send")).toBe(staleGeneration);
    expect(cell.get().lastClaimedGeneration).toBe(currentGeneration);
    stale.fail({ origin: "transport", reason: "stale failure", acceptedFrames: 0 });
    stale.begin();
    expect(cell.get().phase).toBe(initialWebuiStreamState.phase);
    expect(cell.get().refusal).toBeUndefined();

    // The live sink still writes normally.
    current.fail({ origin: "transport", reason: "current failure", acceptedFrames: 0 });
    expect(cell.get().phase).toBe("refused");
    expect(cell.get().refusal).toBe("current failure");
  });

  it("keeps the generation fence out of reach of the anchor page", () => {
    const cell = streamCell();
    const lifecycle = createWebuiTurnLifecycleCommands({
      setStream: cell.setStream,
      setSending: () => undefined,
    });
    const sink = openSink(cell);
    const generation = sink.claim("local-send");

    // The seed fields the attach path needs still land.
    sink.anchor({
      messages: [],
      contextSnapshot: { usage: { used: 11 } },
    });
    expect(cell.get().contextUsage).toEqual({ used: 11 });
    expect(cell.get().processingStartedAtMs).toBeTypeOf("number");

    // A forged page — a cast, or a plain-JavaScript caller — naming the two
    // fields the fence reads must not reach them. The loop hands the page over
    // raw and the adapter copies only the fields it declared, so an open-ended
    // page cannot rewrite the fence and re-admit every later write from a
    // superseded sink.
    sink.anchor({
      subscription: { owner: "recovered", generation: 0 },
      lastClaimedGeneration: 0,
      phase: "waiting",
    } as unknown as WebuiStreamLoopExtra);
    expect(cell.get().lastClaimedGeneration).toBe(generation);
    expect(cell.get().subscription?.generation).toBe(generation);
    expect(cell.get().phase).not.toBe("waiting");
  });

  it("builds the turn writer from the same intents, without an updateStream member", () => {
    const cell = streamCell();
    const writer = createWebuiTurnCommands({
      kind: "session",
      setStream: cell.setStream,
      setSending: () => undefined,
    });

    expect(Object.keys(writer)).not.toContain("updateStream");
    writer.resetStreamForTurn();
    expect(cell.get().phase).toBe("streaming");
    writer.setStreamRefusal("boom");
    expect(cell.get().refusal).toBe("boom");
    const sink = writer.createSink();
    sink.claim("local-send");
    sink.accept(frame);
    expect(cell.get().messages.map((message) => message.id)).toEqual(["m1"]);
  });

  it("carries the home writer's migration into the migrated writer's sink", () => {
    const home = streamCell();
    const sessionCell = streamCell();
    const writer = createWebuiTurnCommands({
      kind: "home",
      setStream: home.setStream,
      setSending: () => undefined,
      migrateToSession: () => ({
        kind: "session" as const,
        setStream: sessionCell.setStream,
        setSending: () => undefined,
      }),
    });

    expect(writer.kind).toBe("home");
    const migrated = writer.migrateToSession?.("created");
    const sink = migrated?.createSink();
    sink?.claim("local-send");
    sink?.accept(frame);

    expect(home.get().messages).toEqual([]);
    expect(sessionCell.get().messages.map((message) => message.id)).toEqual(["m1"]);
  });
});

/**
 * `purgeSlot` is a published command with no injected optional. The optional was
 * the soft-loss path — absent meant the deleted session's draft and history
 * outlived it.
 *
 * The compile-time half is **not** asserted here, and deliberately: this suite is
 * not in a type-checked program (`tsconfig.test.json` does not include it), so a
 * `@ts-expect-error` written here would never be checked and would read as a guard
 * while guarding nothing. The demonstration is a probe
 * against the real client program — remove the dependency from the shell's
 * construction and `tsc -p tsconfig.client.json` rejects it. What stays here is
 * the runtime half: the delete reaches the command on both paths.
 */
describe("a session delete invokes the composer's purge command", () => {
  it("purges the slot on both deletion paths", async () => {
    const purged: string[] = [];
    const store = createWebuiSessionStore({
      catalog: createWebuiSessionCatalogFromPage(page("a", "b")),
    });
    const workflows = createWebuiSessionWorkflows({
      store,
      composer: createWebuiSessionComposerAccess({ purgeSlot: (key: string) => purged.push(key) }),
      port: {
        deleteSession: async () => ({ success: true }),
        loadSessions: async () => page("b"),
        loadSessionTree: async () => ({ sessions: [], hasMore: false }),
        listArchivedSessions: async () => ({ sessions: [], hasMore: false }),
      } as unknown as Parameters<typeof createWebuiSessionWorkflows>[0]["port"],
    });
    await workflows.remove("a");
    await workflows.removeArchived("b");
    expect(purged).toEqual(["a", "b"]);
  });
});

describe("V15 · a confirmed deletion settles through one teardown", () => {
  function deleteFixture(options: {
    readonly port?: Record<string, unknown>;
    readonly deliveries?: { closeSession: (sessionId: string) => void };
    readonly scope?: boolean;
  } = {}) {
    const store = createWebuiSessionStore({
      catalog: createWebuiSessionCatalogFromPage(page("a", "b")),
    });
    store.updateSession("a", (current) => ({ ...current, sending: true }));
    const composer = createWebuiComposerStore({
      initial: { drafts: { a: "half-written" }, history: { a: ["earlier"] } },
    });
    const closeSession = vi.fn();
    const workflows = createWebuiSessionWorkflows({
      store,
      composer: createWebuiSessionComposerAccess(composer, { isStagedFor: () => true }),
      port: {
        deleteSession: async () => ({ success: true }),
        loadSessions: async () => page("b"),
        loadSessionTree: async () => ({ sessions: [], hasMore: false }),
        ...(options.port ?? {}),
      } as unknown as Parameters<typeof createWebuiSessionWorkflows>[0]["port"],
      deliveries: { closeSession: options.deliveries ? closeSession : closeSession },
      ...(options.scope
        ? { scope: createWebuiSessionScopeManager() }
        : {}),
    });
    return { store, composer, workflows, closeSession };
  }

  it("stops the wire session the deleted session was streaming on", async () => {
    // Revoking the browser's interest in a session is not the same as stopping
    // the delivery loop reading frames for it: the loop holds the socket, and it
    // would keep delivering against a session the server no longer has.
    const { workflows, closeSession } = deleteFixture();
    await workflows.remove("a");
    expect(closeSession).toHaveBeenCalledWith("a");
  });

  it("does not stop a wire session the delete failed on", async () => {
    const { workflows, closeSession } = deleteFixture({
      port: {
        deleteSession: async () => {
          throw new Error("server refused");
        },
      },
    });
    await expect(workflows.remove("a")).rejects.toThrow("server refused");
    // Nothing was confirmed gone, so the session keeps its stream.
    expect(closeSession).not.toHaveBeenCalled();
  });

  it("deletes a confirmed-gone session once, whichever route asks", async () => {
    const deleteSession = vi.fn(async () => ({ success: true }));
    const { workflows, closeSession } = deleteFixture({
      port: { deleteSession },
    });

    await workflows.remove("a");
    // The archived page and the rail are two views of one catalogue: the second
    // route must settle for both rather than issuing a redundant mutation for a
    // session the server already dropped.
    await workflows.remove("a");
    await workflows.removeArchived("a");

    expect(deleteSession).toHaveBeenCalledTimes(1);
    expect(closeSession).toHaveBeenCalledTimes(1);
  });

  it("drops the session's slices once even when the delete arrives twice", async () => {
    const { store, composer, workflows } = deleteFixture();
    await workflows.remove("a");
    await workflows.remove("a");

    const snapshot = store.getSnapshot();
    expect(snapshot.sessions.has("a")).toBe(false);
    expect(snapshot.catalog.entities.has("a")).toBe(false);
    expect(composer.readDraft("a")).toBe("");
    expect(snapshot.catalog.flat.ids).toEqual(["b"]);
  });
});

describe("V36 · this page can act on a session fact another client published", () => {
  function factFixture(drafts: Record<string, string> = { a: "half-written" }) {
    const store = createWebuiSessionStore({
      catalog: createWebuiSessionCatalogFromPage(page("a", "b", "c")),
    });
    store.updateSession("a", (current) => ({ ...current, sending: true }));
    const composer = createWebuiComposerStore({
      initial: { drafts, history: { a: ["earlier"] } },
    });
    const closeSession = vi.fn();
    const invalidated = vi.fn();
    const workflows = createWebuiSessionWorkflows({
      store,
      composer: createWebuiSessionComposerAccess(composer, { isStagedFor: () => true }),
      port: {
        deleteSession: async () => ({ success: true }),
        loadSessions: async () => page("a", "b"),
        loadSessionTree: async () => ({ sessions: [], hasMore: false }),
      } as unknown as Parameters<typeof createWebuiSessionWorkflows>[0]["port"],
      deliveries: { closeSession },
      sessionFactInvalidated: invalidated,
    });
    return { store, composer, workflows, closeSession, invalidated };
  }

  it("publishes a stable retained-draft snapshot until its owner changes it", () => {
    const { workflows } = factFixture();
    const
      initial =workflows.retainedDeletionDrafts();
    expect(workflows.retainedDeletionDrafts()).toBe(
      initial);
    const observed: unknown[] =[];
    workflows.subscribeRetainedDrafts(() => observed.push(workflows.retainedDeletionDrafts()));
    workflows.applyFact({ kind: "deleted", sessionId: "a" });
    const retained =workflows.retainedDeletionDrafts();
    expect(retained).not.toBe(
      initial);
    expect(workflows.retainedDeletionDrafts()).toBe(retained);
    expect(observed).toEqual([retained]);
    workflows.discardRetainedDeletionDraft("a");
    expect(workflows.retainedDeletionDrafts()).toEqual([]);
    expect(workflows.retainedDeletionDrafts()).toBe(observed[1]);
    workflows.dispose();
    expect(workflows.retainedDeletionDrafts()).toEqual([]);
  });

  it("applies a rename to the entity the rail resolves from", () => {
    const { store, workflows } = factFixture();
    workflows.applyFact({ kind: "renamed", sessionId: "a", title: "CLI 起的名字" });

    const session = store.getSnapshot().catalog.entities.get("a");
    expect(session?.title).toBe("CLI 起的名字");
    // The name resolves through the same page both views read, so the row
    // updates without a reload.
    expect(selectWebuiCatalogFlatPage(store.getSnapshot().catalog).sessions[0]?.title).toBe(
      "CLI 起的名字",
    );
  });

  it("re-reads the views that render a model or mode change, since the entity has no field for them", () => {
    const { workflows, invalidated } = factFixture();
    workflows.applyFact({ kind: "re-modelled", sessionId: "a", model: "gpt-5" });
    workflows.applyFact({ kind: "interaction-mode", sessionId: "a", mode: "plan" });
    workflows.applyFact({ kind: "pinned", sessionId: "a", pinned: true });

    // The rail's record carries no model, mode or pinned field, so patching the
    // entity would be inventing one. These are answered by re-reading.
    expect(invalidated).toHaveBeenCalledTimes(3);
  });

  it("drops a hidden session from the catalogue without deleting it", () => {
    const { store, workflows } = factFixture();
    workflows.applyFact({ kind: "visibility", sessionId: "a", hidden: true });

    expect(store.getSnapshot().catalog.flat.ids).toEqual(["b", "c"]);
    // Hidden is not gone: the session record stays, and a later unhide can put it
    // back rather than having to re-read the whole page.
    expect(store.getSnapshot().catalog.entities.has("a")).toBe(true);
  });

  it("settles an externally observed deletion's state, and retains the unsent input", () => {
    const { store, composer, workflows, closeSession } = factFixture();
    workflows.applyFact({ kind: "deleted", sessionId: "a" });

    // The executable state goes exactly as a local delete would take it: the wire
    // session stops, the record is dropped from the store, the catalogue drops the
    // row.
    expect(closeSession).toHaveBeenCalledWith("a");
    expect(store.getSnapshot().sessions.has("a")).toBe(false);
    // What differs is the input the user had not sent. Somebody else deleted the
    // session; destroying their text along with it would be losing their work to a
    // fact about the catalogue, so it is retained instead of purged.
    expect(composer.readDraft("a")).toBe("half-written");
    expect(workflows.retainedDeletionDrafts().map((entry) => entry.sessionId)).toEqual(["a"]);
    // And it settles once: a local delete arriving after the event does not
    // repeat the teardown or issue a second request.
    void workflows.remove("a");
    expect(closeSession).toHaveBeenCalledTimes(1);
  });

  it("retires a retained draft when the user copies, transfers or discards it", () => {
    const { composer, workflows } = factFixture({ a: "half-written", b: "b-text", c: "c-text" });
    workflows.applyFact({ kind: "deleted", sessionId: "a" });

    // Copying hands back the text and retires the notice: the user acted on it.
    expect(workflows.copyRetainedDeletionDraft("a")).toBe("half-written");
    expect(workflows.retainedDeletionDrafts()).toEqual([]);

    // Discarding is the third way out, and it drops the record without writing.
    workflows.applyFact({ kind: "deleted", sessionId: "b" });
    workflows.discardRetainedDeletionDraft("b");
    expect(workflows.retainedDeletionDrafts()).toEqual([]);

    // A transfer puts the input into a slot and retires the record the same way.
    workflows.applyFact({ kind: "deleted", sessionId: "c" });
    const moved = workflows.transferRetainedDeletionDraft("c", "target");
    expect(moved?.draft).toBe("c-text");
    expect(composer.readDraft("target")).toBe("c-text");
    expect(workflows.retainedDeletionDrafts()).toEqual([]);
  });

  it("retains nothing when the deleted session had no unsent input", () => {
    const { workflows } = factFixture({});
    // A session the user never typed into produces no notice: an empty bucket is
    // not something to tell them about.
    workflows.applyFact({ kind: "deleted", sessionId: "b" });
    expect(workflows.retainedDeletionDrafts()).toEqual([]);
  });

  it("keeps a local delete's own semantics: the slot goes with the task", async () => {
    const { store, composer, workflows } = factFixture();
    // The user asked for this one, so the composer slot is part of what they
    // ended — the opposite of the external case above, on purpose.
    await workflows.remove("a");
    expect(store.getSnapshot().sessions.has("a")).toBe(false);
    expect(composer.readDraft("a")).toBe("");
    expect(workflows.retainedDeletionDrafts()).toEqual([]);
  });

  it("ignores a fact about a session this client never read", () => {
    const { store, workflows, invalidated } = factFixture();
    workflows.applyFact({ kind: "renamed", sessionId: "not-loaded", title: "别处建的" });

    // The authoritative copy arrives with the next page of the catalogue.
    // Synthesising an entity here would put a record in the rail that no read
    // ever produced.
    expect(store.getSnapshot().catalog.entities.has("not-loaded")).toBe(false);
    expect(invalidated).not.toHaveBeenCalled();
  });
});
