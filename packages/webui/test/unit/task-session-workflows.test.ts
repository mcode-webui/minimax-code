/**
 * The task/session creation use case and the guards the canonical store
 * exposes to it.
 *
 * The cases below are the distinguishing ones: single
 * flight per home incarnation, a destination that wins, a purged destination
 * that is not resurrected, a home incarnation that moved under an in-flight
 * creation, the captured input revision, the recorded Agent Team choice, a
 * catalogue read that fails without undoing the session, and a selection that
 * follows the originating navigation claim rather than the completion itself.
 */
import { describe, expect, it } from "vitest";

import {
  createWebuiSessionStore,
  type WebuiSessionStore,
} from "../../src/client/application/session-store.js";
import { createWebuiComposerStore } from "../../src/client/features/composer/application/composer-store.js";
import { WEBUI_COMPOSER_HOME_KEY } from "../../src/client/features/composer/application/composer-history.js";
import {
  createWebuiTaskSessionWorkflows,
  type WebuiTaskSessionWorkflows,
} from "../../src/client/application/task-session-workflows.js";
import { WEBUI_HOME_SESSION_KEY } from "../../src/client/application/state.js";
import type { WebuiClientSession } from "../../src/client/features/sessions/contracts/session-view.js";
import type {
  WebuiClientCreateSessionRequest,
  WebuiClientCreateSessionResult,
} from "../../src/client/features/sessions/contracts/session-port.js";

function session(sessionId: string, workspaceDir?: string): WebuiClientSession {
  return {
    sessionId,
    ...(workspaceDir ? { workspaceDir } : {}),
  } as unknown as WebuiClientSession;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

interface HarnessOptions {
  readonly createSession?: (
    request: WebuiClientCreateSessionRequest,
  ) => Promise<WebuiClientCreateSessionResult>;
  readonly loadFlat?: () => Promise<void>;
  readonly loadTree?: () => Promise<void>;
  readonly store?: WebuiSessionStore;
  readonly noProjectPersisted?: boolean;
}

function harness(options: HarnessOptions = {}) {
  const store = options.store ?? createWebuiSessionStore();
  const composer = createWebuiComposerStore();
  const created: WebuiClientCreateSessionRequest[] = [];
  const teamModeRecorded: string[] = [];
  const flags: boolean[] = [];
  const catalogueCalls: string[] = [];
  const workflows: WebuiTaskSessionWorkflows = createWebuiTaskSessionWorkflows({
    store,
    composer,
    storage: {
      readNoProjectFlag: () => options.noProjectPersisted ?? false,
      writeNoProjectFlag: (value) => flags.push(value),
    },
    catalogue: {
      canLoadFlat: true,
      canLoadTree: true,
      loadFlat: async () => {
        catalogueCalls.push("flat");
        await options.loadFlat?.();
      },
      loadTree: async () => {
        catalogueCalls.push("tree");
        await options.loadTree?.();
      },
    },
    ...(options.createSession
      ? {
          createSession: (request) => {
            created.push(request);
            return options.createSession!(request);
          },
        }
      : {}),
    recordTeamMode: (sessionId) => teamModeRecorded.push(sessionId),
  });
  return { store, composer, workflows, created, teamModeRecorded, flags, catalogueCalls };
}

describe("the canonical store's guarded transfer", () => {
  it("moves a home record onto an absent destination and reports it", () => {
    const store = createWebuiSessionStore();
    store.createSessionWriter({ kind: "home" }).setSending(true);
    const result = store.transferSession(WEBUI_HOME_SESSION_KEY, "s1");
    expect(result.outcome).toBe("transferred");
    expect(store.hasSession(WEBUI_HOME_SESSION_KEY)).toBe(false);
    expect(store.readSession("s1").sending).toBe(true);
  });

  it("preserves a destination that already holds a record", () => {
    const store = createWebuiSessionStore();
    store.createSessionWriter({ kind: "home" }).setSending(true);
    store.createSessionWriter({ kind: "session", sessionId: "s1" }).setSending(false);
    const result = store.transferSession(WEBUI_HOME_SESSION_KEY, "s1");
    expect(result.outcome).toBe("target-exists");
    // Both records untouched: the destination's own state wins.
    expect(store.readSession("s1").sending).toBe(false);
    expect(store.hasSession(WEBUI_HOME_SESSION_KEY)).toBe(true);
  });

  it("refuses to resurrect a purged destination", () => {
    const store = createWebuiSessionStore();
    store.createSessionWriter({ kind: "home" }).setSending(true);
    store.purgeSession("s1");
    expect(store.transferSession(WEBUI_HOME_SESSION_KEY, "s1").outcome).toBe("purged");
    expect(store.readSession("s1").sending).toBe(false);
    expect(store.hasSession(WEBUI_HOME_SESSION_KEY)).toBe(true);
  });

  it("refuses a source whose incarnation is no longer the live one", () => {
    const store = createWebuiSessionStore();
    store.createSessionWriter({ kind: "home" }).setSending(true);
    const captured = store.readHomeIncarnation();
    store.resetHomeRecord();
    const result = store.transferSession(WEBUI_HOME_SESSION_KEY, "s1", {
      expectSourceIncarnation: captured,
    });
    expect(result.outcome).toBe("stale-source");
    expect(store.readSession("s1").sending).toBe(false);
  });

  it("reports no-source for a key that holds nothing and for the same key twice", () => {
    const store = createWebuiSessionStore();
    expect(store.transferSession(WEBUI_HOME_SESSION_KEY, "s1").outcome).toBe("no-source");
    expect(store.transferSession("s1", "s1").outcome).toBe("no-source");
  });

  it("reports disposed after disposal rather than moving anything", () => {
    const store = createWebuiSessionStore();
    store.createSessionWriter({ kind: "home" }).setSending(true);
    store.dispose();
    expect(store.transferSession(WEBUI_HOME_SESSION_KEY, "s1").outcome).toBe("disposed");
  });

  it("advances the home incarnation even while the selection stays undefined", () => {
    const store = createWebuiSessionStore();
    const before = store.readHomeIncarnation();
    store.resetHomeRecord();
    expect(store.readHomeIncarnation()).toBe(before + 1);
    expect(store.getSelectedSessionId()).toBeUndefined();
  });
});

describe("the composer store's versioned adoption", () => {
  it("moves the home slot when the captured revision still holds", () => {
    const composer = createWebuiComposerStore();
    composer.setDraft(WEBUI_COMPOSER_HOME_KEY, "hello");
    const revision = composer.readSlotRevision(WEBUI_COMPOSER_HOME_KEY);
    const moved = composer.adoptHome("s1", { expectSourceRevision: revision });
    expect(moved).toBe(true);
    expect(composer.readDraft("s1")).toBe("hello");
    expect(composer.readDraft(WEBUI_COMPOSER_HOME_KEY)).toBe("");
  });

  it("keeps input typed during creation instead of moving it", () => {
    const composer = createWebuiComposerStore();
    composer.setDraft(WEBUI_COMPOSER_HOME_KEY, "hello");
    const revision = composer.readSlotRevision(WEBUI_COMPOSER_HOME_KEY);
    composer.setDraft(WEBUI_COMPOSER_HOME_KEY, "hello, and more");
    expect(composer.adoptHome("s1", { expectSourceRevision: revision })).toBe(false);
    expect(composer.readDraft(WEBUI_COMPOSER_HOME_KEY)).toBe("hello, and more");
    expect(composer.readDraft("s1")).toBe("");
  });
});

describe("the creation use case", () => {
  it("reports unsupported without any wire IO when the host cannot create", async () => {
    const { workflows, created } = harness();
    await expect(workflows.submit({})).resolves.toEqual({ kind: "unsupported" });
    expect(created).toHaveLength(0);
  });

  it("issues exactly one create for two submissions in the same home incarnation", async () => {
    const gate = deferred<WebuiClientCreateSessionResult>();
    const { workflows, created } = harness({ createSession: () => gate.promise });
    const first = workflows.submit({});
    await Promise.resolve();
    const second = await workflows.submit({});
    expect(second).toEqual({ kind: "busy", homeIncarnation: 1 });
    expect(created).toHaveLength(1);
    gate.resolve({ sessionId: "s1" });
    await expect(first).resolves.toMatchObject({ kind: "created", sessionId: "s1" });
    expect(created).toHaveLength(1);
  });

  it("admits a new creation after an explicit New Task replaced the home slot", async () => {
    const gate = deferred<WebuiClientCreateSessionResult>();
    let calls = 0;
    const { workflows } = harness({
      createSession: () => {
        calls += 1;
        return calls === 1 ? gate.promise : Promise.resolve({ sessionId: "s2" });
      },
    });
    const first = workflows.submit({});
    await Promise.resolve();
    workflows.beginNewTask();
    await expect(workflows.submit({})).resolves.toMatchObject({
      kind: "created",
      sessionId: "s2",
    });
    gate.resolve({ sessionId: "s1" });
    // The late attempt still settles, and it reports that it could not adopt.
    const late = await first;
    expect(late).toMatchObject({ kind: "created", sessionId: "s1", transfer: "stale-source" });
  });

  it("leaves the replaced home record alone when the incarnation moved", async () => {
    const gate = deferred<WebuiClientCreateSessionResult>();
    const { workflows, store, composer } = harness({ createSession: () => gate.promise });
    composer.setDraft(WEBUI_COMPOSER_HOME_KEY, "old attempt");
    const first = workflows.submit({});
    await Promise.resolve();
    workflows.beginNewTask();
    // The new home is the one the user is typing into.
    store.createSessionWriter({ kind: "home" }).setSending(true);
    composer.setDraft(WEBUI_COMPOSER_HOME_KEY, "new attempt");
    gate.resolve({ sessionId: "s1" });
    await first;
    expect(composer.readDraft(WEBUI_COMPOSER_HOME_KEY)).toBe("new attempt");
    expect(store.readSession(WEBUI_HOME_SESSION_KEY).sending).toBe(true);
    expect(store.readSession("s1").sending).toBe(false);
  });

  it("does not select the created destination once the navigation claim moved", async () => {
    const gate = deferred<WebuiClientCreateSessionResult>();
    const { workflows } = harness({ createSession: () => gate.promise });
    // The boot route establishes the claim the creation captures.
    workflows.noteNavigation(undefined);
    const first = workflows.submit({});
    await Promise.resolve();
    workflows.noteNavigation("other");
    gate.resolve({ sessionId: "s1" });
    await expect(first).resolves.toMatchObject({ kind: "created", selected: false });
  });

  it("records the Agent Team choice the request carried, and only then", async () => {
    const plain = harness({ createSession: async () => ({ sessionId: "s1" }) });
    await plain.workflows.submit({});
    expect(plain.teamModeRecorded).toEqual([]);
    const teamOff = harness({ createSession: async () => ({ sessionId: "s2" }) });
    await teamOff.workflows.submit({ teamModeOff: true });
    expect(teamOff.teamModeRecorded).toEqual(["s2"]);
  });

  it("reports a failed create and a bodyless response as creation-failed", async () => {
    const failed = harness({ createSession: async () => Promise.reject(new Error("nope")) });
    await expect(failed.workflows.submit({})).resolves.toEqual({
      kind: "creation-failed",
      error: "nope",
    });
    const bodyless = harness({ createSession: async () => ({}) });
    const outcome = await bodyless.workflows.submit({});
    expect(outcome).toMatchObject({ kind: "creation-failed" });
  });

  it("records a catalogue failure without undoing the created session", async () => {
    const { workflows, store } = harness({
      createSession: async () => ({ sessionId: "s1" }),
      loadFlat: async () => {
        throw new Error("catalogue down");
      },
    });
    // A home turn is in flight: the creation has a record to carry across.
    store.createSessionWriter({ kind: "home" }).setSending(true);
    const outcome = await workflows.submit({});
    expect(outcome).toMatchObject({ kind: "created", sessionId: "s1" });
    if (outcome.kind !== "created") throw new Error("expected created");
    expect(outcome.catalogueError).toBe("catalogue down");
    expect(outcome.transfer).toBe("transferred");
  });
});

describe("the task workspace policy", () => {
  it("prefers the selected session, then the first session with a project", () => {
    const { workflows } = harness();
    const sessions = [session("a"), session("b", "/b")];
    expect(workflows.initialWorkspaceDir({ selectedSessionId: "a", sessions })).toBe("/b");
    expect(
      workflows.initialWorkspaceDir({
        selectedSessionId: "b",
        sessions: [session("a", "/a"), ...sessions],
      }),
    ).toBe("/b");
  });

  it("honours a persisted no-project choice", () => {
    const { workflows } = harness({ noProjectPersisted: true });
    expect(
      workflows.initialWorkspaceDir({ selectedSessionId: "a", sessions: [session("a", "/a")] }),
    ).toBeUndefined();
  });

  it("stops auto-filling once the user cleared the project in this session", () => {
    const { workflows, flags } = harness();
    const sessions = [session("a", "/a")];
    expect(workflows.chooseWorkspaceDir(undefined)).toBeUndefined();
    expect(flags).toEqual([true]);
    expect(workflows.autoFillWorkspaceDir({ current: undefined, selectedSessionId: "a", sessions })).toBeUndefined();
    expect(workflows.chooseWorkspaceDir("/picked")).toBe("/picked");
    expect(flags).toEqual([true, false]);
    expect(workflows.autoFillWorkspaceDir({ current: "/picked", selectedSessionId: "a", sessions })).toBe("/a");
  });
});

describe("the navigation epoch", () => {
  it("advances on a real change and not on a repeat", () => {
    const { workflows } = harness();
    const boot = workflows.noteNavigation(undefined);
    expect(workflows.noteNavigation(undefined)).toBe(boot);
    const moved = workflows.noteNavigation("s1");
    expect(moved).toBe(boot + 1);
    expect(workflows.noteNavigation("s1")).toBe(moved);
    expect(workflows.noteNavigation(undefined)).toBe(moved + 1);
  });

  it("advances on an explicit New Task even when the selection is already home", () => {
    const { workflows } = harness();
    const boot = workflows.noteNavigation(undefined);
    expect(workflows.beginNewTask().navigationEpoch).toBeGreaterThan(boot);
  });
});
