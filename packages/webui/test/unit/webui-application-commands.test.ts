// Unit tests for the composer's send/queue/attach commands and application
// owned runtime facts.
//
// The suite drives application commands directly and also exercises the app's
// event ingress in the assembled lifecycle suite, pinning the properties these
// cases cover: one probe per concurrent same-session request, the queue branch's
// draft-clear/refusal behaviour and the attach/recheck/gap-recovery decisions.

import { describe, expect, it, vi } from "vitest";

import { createWebuiActiveTurnProbe, webuiActiveTurnProbeFor } from "../../src/client/features/turn/contracts/active-turn-probe.js";
import { queueWebuiTurn } from "../../src/client/features/turn/application/queue-command.js";
import {
  recoverMissedWebuiTurn,
  recheckWebuiSubscription,
  sendWebuiTurn,
} from "../../src/client/features/turn/application/turn-commands.js";
import { initialWebuiStreamState, settleStaleWebuiSubscription, type WebuiStreamState } from "../../src/client/features/turn/projection/stream-state.js";
import {
  createWebuiSessionStore,
  createWebuiTranscriptHistoryWriter,
} from "../../src/client/application/session-store.js";
import { createWebuiTranscriptHistoryOwner } from "../../src/client/conversation/transcript-history.js";
import { selectWebuiSessionTranscriptPage } from "../../src/client/application/selectors.js";
import { createWebuiAccountWorkflows } from "../../src/client/features/account/application/account-workflows.js";
import { createWebuiApplication } from "../../src/client/application/create-application.js";
import { WEBUI_HOME_SESSION_KEY } from "../../src/client/application/state.js";
import { createWebuiPortSlices } from "../../src/client/application/port-slices.js";
import { createWebuiSessionCatalogFromPage, reduceWebuiCatalogTreeLoaded } from "../../src/client/features/sessions/application/session-catalog.js";
import { createWebuiSettingsWorkflows } from "../../src/client/features/settings/application/settings-workflows.js";
import type { WebuiClientMessagePage } from "../../src/client/features/transcript/contracts/message-view.js";
import type { WebuiUsageQuotaResult } from "../../src/shared/contracts/usage-quota.js";
import type { WebuiVersionInfo } from "../../src/shared/contracts/version.js";
import type { WebuiSessionActivityMap } from "../../src/client/features/sessions/projection/session-activity.js";
import type { WebuiActiveTurn } from "../../src/shared/contracts/session.js";
import type { WebuiRuntimeEvent } from "../../src/shared/contracts/stream.js";
import type { WebuiDeliverySink } from "../../src/shared/contracts/delivery.js";
import type { WebuiComposerSubmitHandlers } from "../../src/client/features/composer/contracts/composer-turn.js";

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

/** A sink that accepts every write; the sends under test never open a loop. */
const noopSink: WebuiDeliverySink = {
  claim: () => undefined,
  accept: () => undefined,
  begin: () => undefined,
  recovering: () => undefined,
  anchor: () => undefined,
  replace: () => undefined,
  complete: () => undefined,
  fail: () => undefined,
  release: () => undefined,
};

/** The composer's stream writes, all inert except the ones a test asserts on. */
function commandHandlers(
  overrides: Partial<WebuiComposerSubmitHandlers> = {},
): WebuiComposerSubmitHandlers {
  return {
    createSink: () => noopSink,
    resetStreamForTurn: () => undefined,
    setRefusal: () => undefined,
    setSending: () => undefined,
    ...overrides,
  };
}

describe("application-owned transcript history", () => {
  it("commits into the session entity and fences a late result after switching sessions", async () => {
    let resolveA: (page: WebuiClientMessagePage) => void = () => {};
    const store = createWebuiSessionStore();
    const owner = createWebuiTranscriptHistoryOwner({
      transcript: createWebuiTranscriptHistoryWriter(store),
      loadMessages: vi.fn(
        ({ id }: { readonly id: string; readonly before?: string }): Promise<WebuiClientMessagePage> =>
          id === "A"
            ? new Promise((resolve) => { resolveA = resolve; })
            : Promise.resolve({ messages: [{ msgId: "B-message" }] }),
      ),
    });
    const loadA = owner.loadPage("A");
    const loadB = owner.loadPage("B");
    await expect(loadB).resolves.toMatchObject({ status: "applied" });
    resolveA({ messages: [{ msgId: "A-late" }] });
    await expect(loadA).resolves.toEqual({ status: "stale" });

    expect(store.readSession("B").transcript.page.messages?.map((message) => message.msgId))
      .toEqual(["B-message"]);
    expect(store.readSession("A").transcript.page.messages).toBeUndefined();
  });

  // The shell's workspace-progress backfill reads this slice instead of
  // fetching a second copy: the owner is the one reader of `loadMessages`, so
  // a superseded request must not resurface through the projection either.
  it("does not resurface a fenced response through the transcript-page selector", async () => {
    let resolveA: (page: WebuiClientMessagePage) => void = () => {};
    const store = createWebuiSessionStore();
    const owner = createWebuiTranscriptHistoryOwner({
      transcript: createWebuiTranscriptHistoryWriter(store),
      loadMessages: vi.fn(
        ({ id }: { readonly id: string; readonly before?: string }): Promise<WebuiClientMessagePage> =>
          id === "A"
            ? new Promise((resolve) => { resolveA = resolve; })
            : Promise.resolve({ messages: [{ msgId: "B-message" }] }),
      ),
    });
    const loadA = owner.loadPage("A");
    await expect(owner.loadPage("B")).resolves.toMatchObject({ status: "applied" });
    resolveA({ messages: [{ msgId: "A-late" }] });
    await expect(loadA).resolves.toEqual({ status: "stale" });

    // What the shell now reads: session B's committed page, and nothing at all
    // for the session whose request was fenced.
    expect(
      selectWebuiSessionTranscriptPage(store.getSnapshot(), "B").messages?.map(
        (message) => message.msgId,
      ),
    ).toEqual(["B-message"]);
    expect(
      selectWebuiSessionTranscriptPage(store.getSnapshot(), "A").messages,
    ).toBeUndefined();
    // An unknown session reads the shared empty page rather than throwing.
    expect(selectWebuiSessionTranscriptPage(store.getSnapshot(), undefined)).toEqual({});
  });

  it("lets only the newest request for one session commit", async () => {
    // The other side of the same fence: two loads for ONE session, the earlier
    // one resolving last. The superseded page must not land. Pinned here
    // because the request-ownership coordinator that used to carry its own copy
    // of this rule had no production caller and was removed.
    const pending: Array<(page: WebuiClientMessagePage) => void> = [];
    const store = createWebuiSessionStore();
    const owner = createWebuiTranscriptHistoryOwner({
      transcript: createWebuiTranscriptHistoryWriter(store),
      loadMessages: vi.fn(
        (): Promise<WebuiClientMessagePage> =>
          new Promise((resolve) => {
            pending.push(resolve);
          }),
      ),
    });
    const older = owner.loadPage("A");
    const newer = owner.refreshPage("A");
    expect(pending).toHaveLength(2);

    pending[1]?.({ messages: [{ msgId: "newest" }] });
    await expect(newer).resolves.toMatchObject({ status: "applied" });
    pending[0]?.({ messages: [{ msgId: "superseded" }] });
    await expect(older).resolves.toEqual({ status: "stale" });

    expect(
      store.readSession("A").transcript.page.messages?.map((message) => message.msgId),
    ).toEqual(["newest"]);
  });
});

describe("application-owned runtime facts", () => {
  it("reads the usage quota through the account owner, with a superseded answer dropped", async () => {
    // The shell used to hold its own `usageQuota` state and call
    // `transport.getUsageQuota` with its own `cancelled` flag, so the banner
    // and the user menu could disagree about one answer.
    const pending: Array<(result: WebuiUsageQuotaResult) => void> = [];
    const getUsageQuota = vi.fn(
      (): Promise<WebuiUsageQuotaResult> =>
        new Promise((resolve) => { pending.push(resolve); }),
    );
    const workflows = createWebuiAccountWorkflows({ port: { getUsageQuota } });
    expect(workflows.canReadUsage).toBe(true);

    const first = workflows.loadUsage();
    const second = workflows.loadUsage();
    expect(getUsageQuota).toHaveBeenCalledTimes(2);
    expect(workflows.getSnapshot().usage).toEqual({ status: "loading" });

    // The superseded answer is dropped rather than applied over the newer one.
    const superseded = pending[0];
    const current = pending[1];
    expect(superseded).toBeDefined();
    expect(current).toBeDefined();
    superseded?.({ signedIn: true });
    await first;
    expect(workflows.getSnapshot().usage).toEqual({ status: "loading" });

    current?.({ signedIn: false });
    await second;
    expect(workflows.getSnapshot().usage).toEqual({
      status: "ready",
      result: { signedIn: false },
    });
  });

  it("reads the runtime version through the settings owner", async () => {
    const version: WebuiVersionInfo = { version: "0.6.3", protocolVersion: 3 };
    const workflows = createWebuiSettingsWorkflows({
      port: { version: vi.fn(async () => version) },
    });
    expect(workflows.canReadVersion).toBe(true);
    expect(workflows.getSnapshot().runtimeVersion).toEqual({ status: "idle" });

    await workflows.loadVersion();
    expect(workflows.getSnapshot().runtimeVersion).toEqual({
      status: "ready",
      value: version,
    });
  });

  it("reports an unwired version port rather than leaving the reader waiting", async () => {
    const workflows = createWebuiSettingsWorkflows({ port: {} });
    expect(workflows.canReadVersion).toBe(false);
    await workflows.loadVersion();
    expect(workflows.getSnapshot().runtimeVersion.status).toBe("error");
  });
});

function runtimeEvent(
  type: string,
  payload: Record<string, unknown>,
): WebuiRuntimeEvent {
  return { type, payload, timestamp: 1, source: "test" };
}

describe("the deduplicated active-turn probe", () => {
  it("coalesces concurrent same-session requests into one round trip", async () => {
    let resolveProbe: (value: WebuiActiveTurn | undefined) => void = () => {};
    const getActiveTurn = vi.fn(
      () => new Promise<WebuiActiveTurn | undefined>((resolve) => {
        resolveProbe = resolve;
      }),
    );
    const probe = createWebuiActiveTurnProbe(getActiveTurn);

    const first = probe.probe("s1");
    const second = probe.probe("s1");
    expect(getActiveTurn).toHaveBeenCalledTimes(1);

    resolveProbe({ turnId: "t1", busyReason: "turn", locallyOwned: false });
    expect(await first).toEqual({ turnId: "t1", busyReason: "turn", locallyOwned: false });
    expect(await second).toBe(await first);
  });

  it("probes each session independently and re-probes once settled", async () => {
    const getActiveTurn = vi.fn(async () => undefined);
    const probe = createWebuiActiveTurnProbe(getActiveTurn);

    await Promise.all([probe.probe("s1"), probe.probe("s2")]);
    expect(getActiveTurn).toHaveBeenCalledTimes(2);
    // A later call is a fresh request, not the settled one.
    await probe.probe("s1");
    expect(getActiveTurn).toHaveBeenCalledTimes(3);
  });

  it("shares one probe per transport function, and none without one", () => {
    const getActiveTurn = async () => undefined;
    expect(webuiActiveTurnProbeFor(getActiveTurn)).toBe(webuiActiveTurnProbeFor(getActiveTurn));
    expect(webuiActiveTurnProbeFor(undefined)).toBeUndefined();
  });
});

describe("the queue command", () => {
  it("enqueues, clears the draft and refreshes the panel", async () => {
    const enqueueMessage = vi.fn(async () => ({}));
    const onQueued = vi.fn();
    await queueWebuiTurn({
      sessionId: "s1",
      message: "hello",
      enqueueMessage,
      onQueued,
      setRefusal: vi.fn(),
    });
    expect(enqueueMessage).toHaveBeenCalledWith({ id: "s1", content: "hello" });
    expect(onQueued).toHaveBeenCalled();
  });

  it("surfaces a failed enqueue as a refusal", async () => {
    const setRefusal = vi.fn();
    await queueWebuiTurn({
      sessionId: "s1",
      message: "hello",
      enqueueMessage: vi.fn(async () => {
        throw new Error("queue refused");
      }),
      setRefusal,
    });
    expect(setRefusal).toHaveBeenCalledWith("queue refused");
  });

  it("is a no-op without an enqueuer", async () => {
    await queueWebuiTurn({ sessionId: "s1", message: "x", setRefusal: vi.fn() });
  });
});

describe("the assembled composer controller", () => {
  it("keeps an accepted send and its state settlement alive after view interest detaches", async () => {
    let resolveSend: (() => void) | undefined;
    const sendMessage = vi.fn(async (_message: { readonly id: string; readonly content: string }) => new Promise<void>((resolve) => { resolveSend = resolve; }));
    const app = createWebuiApplication({
      openEventChannel: () => ({ subscribe: () => () => undefined, close: () => undefined }),
      turns: { resumeSession: vi.fn(async () => undefined) },
      turnCapabilities: { sendMessage: sendMessage as never },
    });
    app.start({ initialSessionId: "s1" });
    const detach = app.composerController.attachView("s1");
    const accepted = app.composerController.submit({
      draft: "accepted message",
      sending: false,
      goalEnabled: true,
      agentName: "main",
    });
    detach();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage.mock.calls[0]?.[0]).toMatchObject({ id: "s1", content: "accepted message" });
    expect(app.composer.readHistory("s1")).toEqual(["accepted message"]);
    expect(app.composer.readRetry()).toEqual({ session: "s1", message: "accepted message" });
    expect(app.store.readSession("s1").sending).toBe(true);

    resolveSend?.();
    await expect(accepted).resolves.toEqual({ kind: "submitted", sessionId: "s1" });
    expect(app.store.readSession("s1").sending).toBe(false);

    app.dispose();
  });

  it("reports a submission that needs a session, keeping the draft it could not send", async () => {
    const app = createWebuiApplication({
      openEventChannel: () => ({ subscribe: () => () => undefined, close: () => undefined }),
      turns: { resumeSession: vi.fn(async () => undefined) },
      turnCapabilities: { sendMessage: vi.fn(async () => undefined) as never },
      slices: createWebuiPortSlices({} as never),
    });
    app.start();

    // No selected session and no `createSession` capability: the submission cannot open a turn, and
    // the outcome says so rather than leaving the caller to infer it from a missing callback. The
    // draft stays where the user left it; this used to be read off a settle flag that the submission
    // wrote back through `onNeedsSession`.
    await expect(
      app.composerController.submit({
        draft: "needs a session",
        sending: false,
        goalEnabled: false,
        agentName: "main",
      }),
    ).resolves.toEqual({ kind: "needs-session", draft: "needs a session" });
    app.dispose();
  });

  it("routes enqueue, goal and slash command through the assembled owners", async () => {
    const enqueueMessage = vi.fn(async () => ({}));
    const listQueueMessages = vi.fn(async () => ({ items: [{ itemId: "q1", content: "queued" }] }));
    const runCommand = vi.fn(async () => ({ output: "status output" }));
    const createGoal = vi.fn(async ({ sessionId, objective }: { sessionId: string; objective: string }) => ({
      goalId: "g1", sessionId, objective, status: "active", createdAt: 1, updatedAt: 1,
      tokensUsed: 0, turnsUsed: 0, timeUsedSeconds: 0, tokenBudget: null, statusReason: null,
    }));
    const slices = createWebuiPortSlices({
      runCommand,
      listQueueMessages,
      deleteQueueItem: vi.fn(),
    } as never);
    const app = createWebuiApplication({
      openEventChannel: () => ({ subscribe: () => () => undefined, close: () => undefined }),
      turns: { resumeSession: vi.fn(async () => undefined) },
      turnCapabilities: { enqueueMessage: enqueueMessage as never },
      goalPort: { createGoal: createGoal as never },
      slices,
    });
    app.start({ initialSessionId: "s1" });
    app.store.createSessionWriter({ kind: "session", sessionId: "s1" }).setSending(true);

    await expect(app.composerController.submit({
      draft: "queued text",
      sending: true,
      goalEnabled: true,
      agentName: "main",
    })).resolves.toMatchObject({ kind: "queued", sessionId: "s1" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(enqueueMessage).toHaveBeenCalledWith({ id: "s1", content: "queued text" });
    expect(app.composer.readDraft("s1")).toBe("");
    expect(app.composer.readQueue().items).toEqual([{ itemId: "q1", content: "queued" }]);

    await expect(app.composerController.submit({
      draft: "status now",
      commandMatch: { name: "status", supported: true },
      commandInvocationInput: "now",
      sending: false,
      goalEnabled: true,
      agentName: "target-agent",
    })).resolves.toEqual({ kind: "command-completed", output: "status output" });
    expect(runCommand).toHaveBeenCalledWith({ command: "status", input: "now", sessionId: "s1", agentName: "target-agent" });

    app.composerController.setGoalMode(true);
    await expect(app.composerController.submit({
      draft: "finish this task",
      sending: false,
      goalEnabled: true,
      agentName: "main",
    })).resolves.toMatchObject({ kind: "goal-updated", sessionId: "s1" });
    expect(createGoal).toHaveBeenCalledWith({ sessionId: "s1", objective: "finish this task" });
    app.dispose();
  });

  it("writes a home goal through the created session's goal owner after adoption", async () => {
    const homeGoal = {
      goalId: "home-goal", sessionId: WEBUI_HOME_SESSION_KEY, objective: "old objective",
      status: "active" as const, createdAt: 1, updatedAt: 1, tokensUsed: 0, turnsUsed: 0,
      timeUsedSeconds: 0, tokenBudget: null, statusReason: null,
    };
    const patchedGoal = { ...homeGoal, sessionId: "created-session", objective: "new objective", updatedAt: 2 };
    const store = createWebuiSessionStore();
    store.updateSession(homeGoal.sessionId, (current) => ({ ...current, goal: homeGoal }));
    const patchGoal = vi.fn(async () => patchedGoal);
    const app = createWebuiApplication({
      openEventChannel: () => ({ subscribe: () => () => undefined, close: () => undefined }),
      turns: { resumeSession: vi.fn(async () => undefined) },
      store,
      goalPort: { patchGoal: patchGoal as never },
      slices: createWebuiPortSlices({
        createSession: vi.fn(async () => ({ sessionId: "created-session" })),
      } as never),
    });
    app.start();
    app.composerController.setGoalMode(true);

    const outcome = await app.composerController.submit({
      draft: "new objective",
      sending: false,
      goalEnabled: true,
      agentName: "main",
    });
    expect(outcome).toMatchObject({ kind: "goal-updated", sessionId: "created-session" });

    expect(patchGoal).toHaveBeenCalledWith({ sessionId: "created-session", objective: "new objective" });
    expect(app.store.readSession("created-session").goal).toEqual(patchedGoal);
    expect(app.store.readSession(homeGoal.sessionId).goal).toBeUndefined();
    app.dispose();
  });

  it("does not let a delayed enqueue refresh reclaim the queue mirror after selection changes", async () => {
    let resolveEnqueue: (() => void) | undefined;
    const enqueueMessage = vi.fn(() => new Promise<void>((resolve) => { resolveEnqueue = resolve; }));
    const app = createWebuiApplication({
      openEventChannel: () => ({ subscribe: () => () => undefined, close: () => undefined }),
      turns: { resumeSession: vi.fn(async () => undefined) },
      turnCapabilities: { enqueueMessage: enqueueMessage as never },
      slices: createWebuiPortSlices({
        listQueueMessages: vi.fn(async ({ id }: { id: string }) => ({ items: [{ itemId: id, content: id }] })),
      } as never),
    });
    app.start();
    app.select("s1");
    await flush();
    app.store.createSessionWriter({ kind: "session", sessionId: "s1" }).setSending(true);
    const accepted = app.composerController.submit({
      draft: "queued while selected",
      sending: true,
      goalEnabled: true,
      agentName: "main",
    });
    await flush();
    app.select("s2");
    await flush();
    resolveEnqueue?.();
    await expect(accepted).resolves.toMatchObject({ kind: "queued", sessionId: "s1" });
    await flush();

    expect(app.composer.readQueue()).toEqual({ items: [{ itemId: "s2", content: "s2" }], paused: false });
    app.dispose();
  });

  it("preserves Composer fields on selection and goal/command branches, then clears submitted staging", async () => {
    const attachment = {
      id: "a1", fileName: "notes.txt", mimeType: "text/plain", sizeBytes: 5,
      dataUrl: "data:text/plain;base64,aGVsbG8=", kind: "file" as const,
    };
    const attachmentWire = {
      meta: { attachmentType: "file", fileName: attachment.fileName, mimeType: attachment.mimeType, sizeBytes: attachment.sizeBytes },
      local: { dataUrl: attachment.dataUrl },
    };
    const urlReference = { id: "u1", url: "https://example.test/" };
    const createGoal = vi.fn(async ({ sessionId, objective }: { sessionId: string; objective: string }) => ({
      goalId: "g1", sessionId, objective, status: "active" as const, createdAt: 1, updatedAt: 1,
      tokensUsed: 0, turnsUsed: 0, timeUsedSeconds: 0, tokenBudget: null, statusReason: null,
    }));
    const runCommand = vi.fn(async () => ({ output: "command output" }));
    const sendMessage = vi.fn(async () => undefined);
    const enqueueMessage = vi.fn(async () => undefined);
    const app = createWebuiApplication({
      openEventChannel: () => ({ subscribe: () => () => undefined, close: () => undefined }),
      turns: { resumeSession: vi.fn(async () => undefined) },
      turnCapabilities: { sendMessage: sendMessage as never, enqueueMessage: enqueueMessage as never },
      goalPort: { createGoal: createGoal as never },
      slices: createWebuiPortSlices({ runCommand } as never),
    });
    app.start({ initialSessionId: "s1" });
    const stage = () => {
      app.composerController.setStagedAttachments(() => [attachment]);
      app.composerController.setUrlReferences(() => [urlReference]);
      app.composerController.setAttachmentBusy(true);
      app.composerController.consumeSeed("seed-1");
    };

    app.composerController.setDraft("session one draft", "s1");
    app.composerController.recordInput("earlier input", "s1");
    stage();
    app.composerController.setPlanMode(true);
    app.select("s2");
    expect(app.composer.getSnapshot().modes).toEqual({ goal: false, plan: true });
    expect(app.composer.readDraft("s1")).toBe("session one draft");
    expect(app.composer.readHistory("s1")).toEqual(["earlier input"]);
    expect(app.composer.readStaging()).toEqual({
      attachments: [attachment], urlReferences: [urlReference], busy: true, seedToken: "seed-1",
    });
    app.composerController.setGoalMode(true);
    expect(app.composer.getSnapshot().modes).toEqual({ goal: true, plan: false });
    app.select("s1");
    expect(app.composer.getSnapshot().modes).toEqual({ goal: false, plan: false });

    app.composerController.setGoalMode(true);
    await expect(app.composerController.submit({ draft: "goal objective", sending: false, goalEnabled: true, agentName: "main" }))
      .resolves.toMatchObject({ kind: "goal-updated", sessionId: "s1" });
    expect(app.composer.readStaging().attachments).toEqual([attachment]);
    expect(app.composer.readStaging().urlReferences).toEqual([urlReference]);

    app.composerController.setGoalMode(false);
    await expect(app.composerController.submit({
      draft: "status now", commandMatch: { name: "status", supported: true }, commandInvocationInput: "now",
      sending: false, goalEnabled: true, agentName: "main",
    })).resolves.toMatchObject({ kind: "command-completed" });
    expect(app.composer.readStaging().attachments).toEqual([attachment]);
    expect(app.composer.readStaging().urlReferences).toEqual([urlReference]);

    await expect(app.composerController.submit({
      draft: "send with attachment", attachments: [attachmentWire], sending: false, goalEnabled: true, agentName: "main",
    })).resolves.toMatchObject({ kind: "submitted", sessionId: "s1" });
    expect(app.composer.readStaging().attachments).toEqual([]);
    expect(app.composer.readStaging().urlReferences).toEqual([]);

    stage();
    app.store.createSessionWriter({ kind: "session", sessionId: "s1" }).setSending(true);
    await expect(app.composerController.submit({
      draft: "enqueue attachment", attachments: [attachmentWire], sending: true, goalEnabled: true, agentName: "main",
    })).resolves.toMatchObject({ kind: "queued", sessionId: "s1" });
    expect(app.composer.readStaging().attachments).toEqual([]);
    expect(app.composer.readStaging().urlReferences).toEqual([]);
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(enqueueMessage).toHaveBeenCalledTimes(1);
    app.dispose();
  });

  it("V22 · clears the revision it submitted, and leaves typing that came after it", async () => {
    const sendMessage = vi.fn(async () => undefined);
    const app = createWebuiApplication({
      openEventChannel: () => ({ subscribe: () => () => undefined, close: () => undefined }),
      turns: { resumeSession: vi.fn(async () => undefined) },
      turnCapabilities: { sendMessage: sendMessage as never, enqueueMessage: vi.fn(async () => undefined) as never },
    });
    app.start({ initialSessionId: "s1" });
    app.composerController.setDraft("the first words", "s1");

    const pending = app.composerController.submit({
      draft: "the first words",
      sending: false,
      goalEnabled: true,
      agentName: "main",
    });
    // Consumed on the admission, early, and only for the revision that was submitted.
    expect(app.composer.readDraft("s1")).toBe("");

    // The user types again while the turn is being admitted and delivered.
    app.composerController.setDraft("the second words", "s1");
    await pending;

    // Nothing about the older submission's completion removes newer input: the clear
    // was the captured revision's, and this is not it.
    expect(app.composer.readDraft("s1")).toBe("the second words");
    app.dispose();
  });

  it("resolves a questionnaire requester from its target child session", async () => {
    const catalog = reduceWebuiCatalogTreeLoaded(
      createWebuiSessionCatalogFromPage({ sessions: [], hasMore: false }),
      { sessions: [{
        session: { sessionId: "root", agentName: "root-agent", createdAt: 1, updatedAt: 1 },
        childSessions: [{ sessionId: "child", parentSessionId: "root", agentName: "child-agent", createdAt: 1, updatedAt: 1 }],
      }], hasMore: false },
    );
    const store = createWebuiSessionStore({ catalog });
    const replyQuestionnaire = vi.fn(async () => ({ ok: true }));
    const app = createWebuiApplication({
      openEventChannel: () => ({ subscribe: () => () => undefined, close: () => undefined }),
      turns: { resumeSession: vi.fn(async () => undefined) },
      store,
      interactionsPort: { replyQuestionnaire: replyQuestionnaire as never },
    });

    await app.interactions.owner("child").answerQuestionnaire({ id: "q1", schemaVersion: 3 } as never, []);

    expect(replyQuestionnaire).toHaveBeenCalledWith({
      name: "child-agent", requestId: "q1", schemaVersion: 3, answers: [],
    });
    app.dispose();
  });
});

describe("the send command", () => {
  it("routes to the queue when a turn is already in flight", async () => {
    const enqueueMessage = vi.fn(async () => ({}));
    const writer = {
      kind: "session" as const,
      createSink: vi.fn(() => noopSink),
      resetStreamForTurn: vi.fn(),
      setStreamRefusal: vi.fn(),
      setTurnSending: vi.fn(),
    };
    const ticket = sendWebuiTurn({
      sessionId: "s1",
      intent: { kind: "ordinary", message: "queued" },
      admission: { kind: "queued" },
      sending: true,
      deps: { sendMessage: vi.fn() },
      enqueueMessage,
      createWriter: () => writer,
    });
    expect(ticket?.admission).toEqual({ kind: "queued" });
    await ticket?.completion;
    expect(enqueueMessage).toHaveBeenCalledWith({ id: "s1", content: "queued" });
    expect(writer.setTurnSending).not.toHaveBeenCalled();
    // The queue branch writes nothing to the stream slice: it is the running
    // turn's loop that owns it.
    expect(writer.resetStreamForTurn).not.toHaveBeenCalled();
    expect(writer.setStreamRefusal).not.toHaveBeenCalled();
    expect(writer.createSink).not.toHaveBeenCalled();
  });
});

describe("attach, recheck and gap recovery", () => {
  const busy = { turnId: "t-new", busyReason: "turn" as const, locallyOwned: false };

  it("attaches to the running turn when no lease is held", async () => {
    const attach = vi.fn();
    recoverMissedWebuiTurn({
      sessionId: "s1",
      getActiveTurn: async () => busy,
      readStream: () => initialWebuiStreamState,
      settleStaleSubscription: vi.fn(),
      attach,
    });
    await flush();
    expect(attach).toHaveBeenCalledWith("t-new");
  });

  it("does not attach when the active turn is a compaction", async () => {
    const attach = vi.fn();
    recoverMissedWebuiTurn({
      sessionId: "s1",
      getActiveTurn: async () => ({ turnId: "t-c", busyReason: "compaction", locallyOwned: false }),
      readStream: () => initialWebuiStreamState,
      settleStaleSubscription: vi.fn(),
      attach,
    });
    await flush();
    expect(attach).not.toHaveBeenCalled();
  });

  it("settles the captured lease when recovery confirms that no turn is active", async () => {
    const settleStaleSubscription = vi.fn();
    const stream = {
      ...initialWebuiStreamState,
      phase: "streaming" as const,
      lastClaimedGeneration: 7,
      subscription: { owner: "recovered" as const, generation: 7, turnId: "t-old" },
    };
    recoverMissedWebuiTurn({
      sessionId: "s1",
      getActiveTurn: async () => undefined,
      readStream: () => stream,
      settleStaleSubscription,
      attach: vi.fn(),
    });
    await flush();
    expect(settleStaleSubscription).toHaveBeenCalledTimes(1);
    expect(settleStaleSubscription).toHaveBeenCalledWith(7);
  });

  it("keeps a locally issued send lease when the active-turn read is still empty", async () => {
    const settleStaleSubscription = vi.fn();
    const stream = {
      ...initialWebuiStreamState,
      phase: "streaming" as const,
      lastClaimedGeneration: 7,
      subscription: { owner: "local-send" as const, generation: 7 },
    };
    recoverMissedWebuiTurn({
      sessionId: "s1",
      getActiveTurn: async () => undefined,
      readStream: () => stream,
      settleStaleSubscription,
      attach: vi.fn(),
    });
    await flush();
    expect(settleStaleSubscription).not.toHaveBeenCalled();
  });

  it("does not settle a newer lease when an idle probe resolves late", async () => {
    let resolveProbe!: (active: undefined) => void;
    const probe = { probe: () => new Promise<undefined>((resolve) => { resolveProbe = resolve; }) };
    let stream: WebuiStreamState = {
      ...initialWebuiStreamState,
      lastClaimedGeneration: 7,
      subscription: { owner: "recovered" as const, generation: 7, turnId: "t-old" },
    };
    const settleStaleSubscription = vi.fn();
    recoverMissedWebuiTurn({
      sessionId: "s1",
      probe,
      readStream: () => stream,
      settleStaleSubscription,
      attach: vi.fn(),
    });
    stream = {
      ...stream,
      lastClaimedGeneration: 8,
      subscription: { owner: "local-send", generation: 8 },
    };
    resolveProbe(undefined);
    await flush();
    expect(settleStaleSubscription).not.toHaveBeenCalled();
  });

  it("settles only the stale generation and preserves its transcript", () => {
    const stream = {
      ...initialWebuiStreamState,
      phase: "streaming" as const,
      lastClaimedGeneration: 7,
      subscription: { owner: "recovered" as const, generation: 7, turnId: "t-old" },
      messages: [{ id: "m1", answer: "answer", thinking: "" }],
    };
    const settled = settleStaleWebuiSubscription(stream, 7);
    expect(settled.phase).toBe("idle");
    expect(settled.subscription).toBeUndefined();
    expect(settled.lastClaimedGeneration).toBeUndefined();
    expect(settled.messages).toBe(stream.messages);

    const newer = { ...stream, lastClaimedGeneration: 8 };
    expect(settleStaleWebuiSubscription(newer, 7)).toBe(newer);
  });

  it("recheck retargets a stale lease onto the running turn", async () => {
    const stream = {
      ...initialWebuiStreamState,
      subscription: { owner: "recovered" as const, generation: 7, turnId: "t-old" },
    };
    const releaseSubscription = vi.fn();
    const attach = vi.fn();
    recheckWebuiSubscription({
      sessionId: "s1",
      getActiveTurn: async () => busy,
      readStream: () => stream,
      releaseSubscription,
      attach,
    });
    await flush();
    // Scoped to the generation the probe decided was stale, so a lease claimed
    // while the probe was in flight is not the one that gets dropped.
    expect(releaseSubscription).toHaveBeenCalledTimes(1);
    expect(releaseSubscription).toHaveBeenCalledWith(7);
    expect(attach).toHaveBeenCalledWith("t-new");
  });

  it("recheck holds when the active turn is the lease we already hold", async () => {
    const stream = {
      ...initialWebuiStreamState,
      subscription: { owner: "recovered" as const, generation: 7, turnId: "t-new" },
    };
    const releaseSubscription = vi.fn();
    const attach = vi.fn();
    recheckWebuiSubscription({
      sessionId: "s1",
      getActiveTurn: async () => busy,
      readStream: () => stream,
      releaseSubscription,
      attach,
    });
    await flush();
    expect(releaseSubscription).not.toHaveBeenCalled();
    expect(attach).not.toHaveBeenCalled();
  });

  it("recheck attaches to a queued turn after the previous lease was released", async () => {
    const attach = vi.fn();
    recheckWebuiSubscription({
      sessionId: "s1",
      getActiveTurn: async () => busy,
      readStream: () => initialWebuiStreamState,
      releaseSubscription: vi.fn(),
      attach,
    });
    await flush();
    expect(attach).toHaveBeenCalledTimes(1);
    expect(attach).toHaveBeenCalledWith("t-new");
  });

  it("reconciles persisted history when a turn finishes before the recheck probe", async () => {
    const attach = vi.fn();
    recheckWebuiSubscription({
      sessionId: "s1",
      getActiveTurn: async () => undefined,
      readStream: () => initialWebuiStreamState,
      releaseSubscription: vi.fn(),
      attach,
    });
    await flush();
    expect(attach).toHaveBeenCalledTimes(1);
    expect(attach).toHaveBeenCalledWith(undefined);
  });

  it("does not attach from a no-lease recheck if a newer lease claims during the probe", async () => {
    let resolveProbe!: (active: typeof busy) => void;
    const probe = { probe: () => new Promise<typeof busy>((resolve) => { resolveProbe = resolve; }) };
    let stream: WebuiStreamState = initialWebuiStreamState;
    const attach = vi.fn();
    recheckWebuiSubscription({
      sessionId: "s1",
      probe,
      readStream: () => stream,
      releaseSubscription: vi.fn(),
      attach,
    });
    stream = {
      ...initialWebuiStreamState,
      subscription: { owner: "local-send", generation: 8 },
    };
    resolveProbe(busy);
    await flush();
    expect(attach).not.toHaveBeenCalled();
  });
});
