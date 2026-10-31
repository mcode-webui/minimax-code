// The interaction owner, keyed by session.
//
// The two properties that made this leave the composer, asserted rather than
// assumed: the pending fence belongs to the session whose reads it orders, and
// the owner exists whether or not a view is mounted, so an event route can
// re-read through it and a transcript can reply through it.

import { describe, expect, it, vi } from "vitest";
import { createWebuiInteractionCommands } from "../../src/client/features/sessions/application/session-commands.public.js";

import { createWebuiInteractionSessionOwners } from "../../src/client/features/interactions/application/interaction-session-owners.js";
import { createWebuiSessionStore } from "../../src/client/application/session-store.js";
import { createWebuiInteractionPhaseIntents } from "../../src/client/features/turn/contracts/interaction-phase-intents.js";

/**
 * The phase intents the composition supplies. They are turn's published contract
 * built over this store's session writer, so the owner is handed them rather than
 * importing turn's factory.
 */
const phaseIntentsFor =
  (store: ReturnType<typeof createWebuiSessionStore>) => (sessionId: string) =>
    createWebuiInteractionPhaseIntents({
      setStream: store.createSessionWriter({ kind: "session", sessionId }).setStream,
    });

const permission = (sessionId: string, requestId: string) =>
  ({ sessionId, requestId, toolName: "read", agentName: "main" }) as never;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}


/**
 * The dependencies one owner registry needs, composed the way the assembly
 * composes them: Sessions publishes the interaction commands and the assembly
 * builds them for the session it is creating an owner for.
 */
function ownerDependencies(store: ReturnType<typeof createWebuiSessionStore>) {
  return {
    store,
    readPhaseIntents: phaseIntentsFor(store),
    commandsFor: (sessionId: string) =>
      createWebuiInteractionCommands(
        store.createInteractionWriter({ kind: "session", sessionId }),
      ),
  };
}

describe("interaction owners are keyed by session", () => {
  it("creates one owner per session and keeps it", () => {
    const store = createWebuiSessionStore();
    const owners = createWebuiInteractionSessionOwners({ ...ownerDependencies(store) });

    const a = owners.owner("A");
    expect(owners.owner("A")).toBe(a);
    expect(owners.owner("B")).not.toBe(a);
    expect(owners.sessions()).toEqual(["A", "B"]);
  });

  it("commits a re-read to that session's record and no other", async () => {
    const store = createWebuiSessionStore();
    const owners = createWebuiInteractionSessionOwners({ ...ownerDependencies(store),
      port: {
        listPendingPermissions: async () => ({
          requests: [permission("A", "r1"), permission("B", "r2")],
        }),
      } as never,
    });

    // B already holds a request of its own; A's re-read must not touch it.
    store.updateSession("B", (current) => ({
      ...current,
      permissions: [permission("B", "seed")],
    }));

    await owners.owner("A").refresh();

    // The owner filters to its own session and applies through the narrow writer.
    expect(store.readSession("A").permissions?.map((item) => item.requestId)).toEqual(["r1"]);
    expect(store.readSession("B").permissions?.map((item) => item.requestId)).toEqual(["seed"]);
  });

  it("does not let one session's reply fence another session's pending read", async () => {
    // The defect this exists for: one cell for the whole application, so a reply
    // for B retired a read in flight for A.
    const slowA = deferred<{ requests: readonly never[] }>();
    const store = createWebuiSessionStore();
    const owners = createWebuiInteractionSessionOwners({ ...ownerDependencies(store),
      port: {
        listPendingPermissions: () => slowA.promise,
        replyPermission: async () => ({ ok: true }),
      } as never,
    });

    const readA = owners.owner("A").refresh();
    await owners.owner("B").replyPermission(permission("B", "r2"), "allowOnce");

    slowA.resolve({ requests: [] });
    await expect(readA).resolves.toEqual({ ok: true });
    // A's answer landed: B's reply is B's own fence.
    expect(store.readSession("A").permissions).toEqual([]);
  });

  it("does let a session's own invalidation fence its in-flight read", async () => {
    const slow = deferred<{ requests: readonly never[] }>();
    const store = createWebuiSessionStore();
    const owners = createWebuiInteractionSessionOwners({ ...ownerDependencies(store),
      port: {
        // The answer still names r1: if it landed it would install a request the
        // invalidation just retired.
        listPendingPermissions: () => slow.promise,
      } as never,
    });

    const read = owners.owner("A").refresh();
    // The route's fence, invoked exactly as an event would: this session's
    // pending projection changed under the read.
    owners.owner("A").invalidatePendingReads();
    slow.resolve({ requests: [permission("A", "r1")] });
    await read;

    expect(store.readSession("A").permissions).toEqual([]);
  });

  it("names the session's agent when the questionnaire read asks", async () => {
    const store = createWebuiSessionStore();
    const getPendingQuestionnaire = vi.fn(async () => ({ request: undefined }));
    const owners = createWebuiInteractionSessionOwners({ ...ownerDependencies(store),
      port: { getPendingQuestionnaire } as never,
      readAgentName: (sessionId) => (sessionId === "A" ? "reviewer" : "main"),
    });

    await owners.owner("A").refresh();

    expect(getPendingQuestionnaire).toHaveBeenCalledWith({ name: "reviewer", sessionId: "A" });
  });

  it("drops a session's owner on purge and accepts nothing after disposal", async () => {
    const store = createWebuiSessionStore();
    const owners = createWebuiInteractionSessionOwners({ ...ownerDependencies(store),
      port: { listPendingPermissions: async () => ({ requests: [] }) } as never,
    });
    const first = owners.owner("A");
    owners.purge("A");
    expect(owners.sessions()).toEqual([]);
    // A fresh owner is a fresh fence.
    expect(owners.owner("A")).not.toBe(first);

    owners.dispose();
    expect(owners.isDisposed()).toBe(true);
    expect(owners.sessions()).toEqual([]);
  });
});
