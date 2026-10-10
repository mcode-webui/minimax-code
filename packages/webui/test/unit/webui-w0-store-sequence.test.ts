// W0 safety net — the session store's transition sequence.
//
// The stream/sending slices moved from the module-level runtime map to the one
// application store (`application/session-store.ts`; plan §7.7 stage 4, ticket
// #45 prerequisite 5). Two documented contracts hold there:
//
//   1. `store.migrateSession` deliberately does NOT notify listeners: the only
//      subscriber is the view that is about to switch keys, and the target key
//      has no subscriber yet.
//   2. A turn writer remains pinned to its owning session. It moves only when
//      the first home-screen turn creates the session that owns its stream, and
//      `migrateToSession` re-points the writer without carrying the record —
//      the caller runs the silent `migrateSession` for that.
//
// What this file pins is the observable half: read/update/migrate semantics,
// object identity across a migration, isolation between keys, and the two
// degenerate cases. Each case gets a fresh store so no key leaks across tests.

import { describe, it, expect, afterEach } from "vitest";
import { createWebuiSessionStore } from "../../src/client/application/session-store.js";
import { WEBUI_HOME_SESSION_KEY as HOME_KEY } from "../../src/client/application/state.js";
import { initialWebuiStreamState } from "../../src/client/projection/stream-state.js";

const SESSION_KEY = "w0-session";

let store = createWebuiSessionStore();
afterEach(() => {
  store = createWebuiSessionStore();
});

function initialState(): {
  readonly stream: typeof initialWebuiStreamState;
  readonly sending: boolean;
} {
  return { stream: initialWebuiStreamState, sending: false };
}

/** The stream/sending slices of a key, for comparison against `initialState`. */
function slice(key: string): {
  readonly stream: typeof initialWebuiStreamState;
  readonly sending: boolean;
} {
  const { stream, sending } = store.readSession(key);
  return { stream, sending };
}

describe("W0 · session store transition sequence", () => {
  it("reads the initial state for a key that was never written", () => {
    expect(slice("w0-untouched")).toEqual(initialState());
  });

  it("writes the reducer result under the key it was given", () => {
    store.updateSession(HOME_KEY, (current) => ({
      ...current,
      stream: { ...current.stream, phase: "streaming" },
      sending: true,
    }));

    expect(slice(HOME_KEY)).toEqual({
      stream: { ...initialWebuiStreamState, phase: "streaming" },
      sending: true,
    });
    // The other key must not have been touched by the write.
    expect(slice(SESSION_KEY)).toEqual(initialState());
  });

  it("migrates the live state to the session key and leaves home initial", () => {
    store.updateSession(HOME_KEY, (current) => ({
      ...current,
      stream: { ...current.stream, phase: "streaming" },
      sending: true,
    }));

    store.migrateSession(HOME_KEY, SESSION_KEY);

    expect(slice(HOME_KEY)).toEqual(initialState());
    expect(slice(SESSION_KEY)).toEqual({
      stream: { ...initialWebuiStreamState, phase: "streaming" },
      sending: true,
    });
  });

  it("keeps object identity across a migration", () => {
    // The in-flight turn has to stay on screen while the view switches keys, so
    // the migrated value must be the same object rather than a structural copy.
    store.updateSession(HOME_KEY, (current) => ({
      ...current,
      sending: true,
    }));
    const before = store.readSession(HOME_KEY);

    store.migrateSession(HOME_KEY, SESSION_KEY);

    expect(store.readSession(SESSION_KEY)).toBe(before);
  });

  it("does not create the target key when the source was never written", () => {
    store.migrateSession("w0-missing", SESSION_KEY);

    expect(slice(SESSION_KEY)).toEqual(initialState());
  });

  it("is a no-op when both keys are the same", () => {
    store.updateSession(SESSION_KEY, (current) => ({
      ...current,
      sending: true,
    }));
    const before = store.readSession(SESSION_KEY);

    store.migrateSession(SESSION_KEY, SESSION_KEY);

    expect(store.readSession(SESSION_KEY)).toBe(before);
  });

  it("keeps two session keys isolated from each other", () => {
    store.updateSession(SESSION_KEY, (current) => ({
      ...current,
      sending: true,
    }));

    expect(slice("w0-other-session")).toEqual(initialState());
  });

  it("keeps a session writer fixed to its owner when another session is selected", () => {
    const writer = store.createSessionWriter({
      kind: "session",
      sessionId: SESSION_KEY,
    });
    expect(writer.kind).toBe("session");
    expect("migrateToSession" in writer).toBe(false);
    type AssertFalse<T extends false> = T;
    type SessionWriterHasNoMigration = AssertFalse<
      "migrateToSession" extends keyof typeof writer ? true : false
    >;
    const typeContract: SessionWriterHasNoMigration = false;
    expect(typeContract).toBe(false);

    store.updateSession("w0-other-session", (current) => ({
      ...current,
      stream: { ...current.stream, phase: "streaming" },
    }));

    writer.setStream((current) => ({ ...current, phase: "done" }));
    writer.setSending(false);

    expect(slice(SESSION_KEY)).toMatchObject({
      stream: { phase: "done" },
      sending: false,
    });
    expect(slice("w0-other-session").stream.phase).toBe("streaming");
  });

  it("migrates a home writer once and keeps subsequent writes on that session", () => {
    const homeWriter = store.createSessionWriter({ kind: "home" });
    expect(homeWriter.kind).toBe("home");
    homeWriter.setStream((current) => ({ ...current, phase: "streaming" }));
    store.migrateSession(HOME_KEY, SESSION_KEY);
    const sessionWriter = homeWriter.migrateToSession(SESSION_KEY);
    expect(sessionWriter.kind).toBe("session");
    expect("migrateToSession" in sessionWriter).toBe(false);
    sessionWriter.setStream((current) => ({ ...current, phase: "done" }));
    sessionWriter.setSending(false);

    expect(slice(HOME_KEY)).toEqual(initialState());
    expect(slice(SESSION_KEY)).toEqual({
      stream: { ...initialWebuiStreamState, phase: "done" },
      sending: false,
    });
    expect(slice("w0-other-session")).toEqual(initialState());
  });

  it("rejects a second home writer migration at runtime", () => {
    const homeWriter = store.createSessionWriter({ kind: "home" });

    homeWriter.migrateToSession(SESSION_KEY);

    expect(() => homeWriter.migrateToSession("w0-other-session")).toThrow(
      "Home turn session writer already migrated",
    );
    expect(slice(HOME_KEY)).toEqual(initialState());
    expect(slice(SESSION_KEY)).toEqual(initialState());
    expect(slice("w0-other-session")).toEqual(initialState());
  });
});
