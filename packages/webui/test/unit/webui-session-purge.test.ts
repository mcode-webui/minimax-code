// R7 — write authority on the session slices, and the delete teardown.
//
// Two findings are pinned here.
//
//   1. **A renamed setter is not a narrowed capability.** The application
//      command surface used to hand components `updateStream((current) => next)`
//      plus `updatePermissions` / `updateQuestionnaire`, so a component could
//      rewrite any field of the slice and walk around the generation fence the
//      owner applies. The stream's open-ended writes now come back only as an
//      already-fenced sink, and the un-narrowed updaters are gone.
//
//   2. **A delete left state behind.** Removing a session dropped its catalog
//      entity and nothing else: the session record, its activity entry (unread
//      badge + busy hint) and the composer slot's draft and history all
//      survived, and a load already in flight could put the entity straight
//      back. `purgeSession` / `purgeSlot` and the workflow's delete fence close
//      that hole.
//
// The suites drive the application modules directly — the webui suite has no
// DOM — against scripted ports and in-memory stores.

import { describe, expect, it, vi } from "vitest";

import {
  createWebuiSessionCatalogFromPage,
  initialWebuiSessionCatalogState,
  reduceWebuiCatalogFlatLoaded,
  selectWebuiCatalogFlatPage,
  removeWebuiCatalogSessions,
} from "../../src/client/application/session-catalog.js";
import { createWebuiSessionStore } from "../../src/client/application/session-store.js";
import {
  createWebuiSessionWorkflows,
} from "../../src/client/application/session-workflows.js";
import { createWebuiComposerStore } from "../../src/client/application/composer-store.js";
import {
  createWebuiInteractionCommands,
  createWebuiSessionCommands,
  createWebuiTurnCommands,
} from "../../src/client/application/session-commands.js";
import { WEBUI_HOME_SESSION_KEY } from "../../src/client/application/state.js";
import {
  initialWebuiStreamState,
  type WebuiStreamState,
} from "../../src/client/projection/stream-state.js";
import type { WebuiStreamLoopExtra } from "../../src/client/mechanisms/stream-loop.js";
import type { WebuiSessionActivityMap } from "../../src/client/projection/session-activity.js";
import type { WebuiClientSession } from "../../src/client/contracts/session-view.js";
import type { WebuiSessionListItem } from "../../src/shared/contracts/session.js";
import type { WebuiStreamFrame } from "../../src/shared/contracts/stream.js";

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

const frame: WebuiStreamFrame = {
  dataJson: '{"type":2,"agent_message":{"msg_id":"m1","msg_content":"x"}}',
};

describe("R7 · the session store's purge", () => {
  it("drops the session record and its activity entry, and notifies once", () => {
    const store = createWebuiSessionStore();
    store.updateSession("s1", (current) => ({ ...current, sending: true }));
    store.updateActivity((current): WebuiSessionActivityMap => ({
      ...current,
      s1: { lastActivityAt: 5, unread: 2 },
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
      a: { lastActivityAt: 3, unread: 1 },
    }));
    const composer = createWebuiComposerStore({
      initial: { drafts: { a: "half-written" }, history: { a: ["earlier"] } },
    });
    const workflows = createWebuiSessionWorkflows({
      store,
      composer,
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
      composer,
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
    const commands = createWebuiSessionCommands({
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
    expect(Object.keys(commands)).not.toContain("updateStream");
    expect(Object.keys(interaction)).not.toContain("updatePermissions");
    expect(Object.keys(interaction)).not.toContain("updateQuestionnaire");

    // What replaces it is a factory for the owner's fenced sink, not a setter.
    expect(typeof commands.createStreamSink).toBe("function");
  });

  it("hands out a sink whose writes the owner fences by generation", () => {
    const cell = streamCell();
    const commands = createWebuiSessionCommands({
      setStream: cell.setStream,
      setSending: () => undefined,
    });
    const superseded = commands.createStreamSink();
    const current = commands.createStreamSink();
    // A loop sink always owns the claim; the assertion documents that the
    // fence is part of the sink rather than something the caller adds.
    expect(superseded.claimSubscription).toBeDefined();
    expect(current.claimSubscription).toBeDefined();
    superseded.claimSubscription?.("local-send");
    current.claimSubscription?.("recovered");

    superseded.applyFrame(frame);
    expect(cell.get().messages).toEqual([]);

    current.applyFrame(frame);
    expect(cell.get().messages.map((message) => message.id)).toEqual(["m1"]);
  });

  it("releases only the named generation, so a stale probe cannot clear a newer lease", () => {
    const cell = streamCell();
    const commands = createWebuiSessionCommands({
      setStream: cell.setStream,
      setSending: () => undefined,
    });
    const sink = commands.createStreamSink();
    const generation = sink.claimSubscription?.("local-send");
    expect(cell.get().subscription).toBeDefined();

    commands.releaseStreamSubscription((generation ?? 0) - 1);
    expect(cell.get().subscription).toBeDefined();

    commands.releaseStreamSubscription(generation ?? 0);
    expect(cell.get().subscription).toBeUndefined();
  });

  it("does not let a superseded sink take the lease back by re-claiming", () => {
    const cell = streamCell();
    const commands = createWebuiSessionCommands({
      setStream: cell.setStream,
      setSending: () => undefined,
    });
    // Two turns: `stale` opens first, `current` replaces it. That is the normal
    // way a superseded sink ends up alive — the loop for the old turn has not
    // finished when the newer one claims.
    const stale = commands.createStreamSink();
    const staleGeneration = stale.claimSubscription?.("local-send");
    const current = commands.createStreamSink();
    const currentGeneration = current.claimSubscription?.("recovered");
    expect(cell.get().lastClaimedGeneration).toBe(currentGeneration);

    // A second claim must not mint a newer generation. It used to: the sink
    // wrote a fresh number as `lastClaimedGeneration`, made itself the newest
    // claimant again and could then stamp `refused` over the turn that had
    // replaced it.
    expect(stale.claimSubscription?.("local-send")).toBe(staleGeneration);
    expect(cell.get().lastClaimedGeneration).toBe(currentGeneration);
    stale.refuse("stale failure");
    stale.setPhase("waiting");
    expect(cell.get().phase).toBe(initialWebuiStreamState.phase);
    expect(cell.get().refusal).toBeUndefined();

    // The live sink still writes normally.
    current.refuse("current failure");
    expect(cell.get().phase).toBe("refused");
    expect(cell.get().refusal).toBe("current failure");
  });

  it("keeps the generation fence out of reach of setStreamExtra", () => {
    const cell = streamCell();
    const commands = createWebuiSessionCommands({
      setStream: cell.setStream,
      setSending: () => undefined,
    });
    const sink = commands.createStreamSink();
    const generation = sink.claimSubscription?.("local-send");

    // The seed fields the attach path needs still land.
    sink.setStreamExtra?.({
      contextUsage: { used: 11 },
      processingStartedAtMs: 42,
      resumeRequired: false,
      refusal: undefined,
    });
    expect(cell.get().contextUsage).toEqual({ used: 11 });
    expect(cell.get().processingStartedAtMs).toBe(42);

    // A forged extra — a cast, or a plain-JavaScript caller — naming the two
    // fields the fence reads must not reach them. With the open-ended
    // `Partial<WebuiStreamState>` parameter this rewrote the fence and every
    // later write from a superseded sink passed it.
    const forged = {
      subscription: { owner: "recovered", generation: 0 },
      lastClaimedGeneration: 0,
      phase: "waiting",
    } as unknown as WebuiStreamLoopExtra;
    sink.setStreamExtra?.(forged);
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
    sink.claimSubscription?.("local-send");
    sink.applyFrame(frame);
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
    sink?.claimSubscription?.("local-send");
    sink?.applyFrame(frame);

    expect(home.get().messages).toEqual([]);
    expect(sessionCell.get().messages.map((message) => message.id)).toEqual(["m1"]);
  });
});
