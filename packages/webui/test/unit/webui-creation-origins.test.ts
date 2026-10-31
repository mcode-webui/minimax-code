// The four creation origins, driven at the application level with nothing mounted.
//
// The four origins, all reachable with nothing mounted: the ordinary send, the
// goal submission, the plugin-chat creation, and the rail's project/New-Task
// actions.
//
// Nothing here renders React or the shell. Each case drives the assembled
// application the way its surface does — the composer controller for a send and for
// a goal, the task use case for the plugin-chat action and for the rail — and
// asserts the completion the use case owns: exactly one create, the guarded
// transfer of the home turn onto the created session, the composer's slot move, the
// Agent Team choice the request carried, the catalogue refresh, and whether the
// created session may be selected.

import { describe, expect, it, vi } from "vitest";

import { createWebuiApplication } from "../../src/client/application/create-application.js";
import { createWebuiApplicationFixture } from "./support/application-fixture.js";
import { createWebuiPortSlices } from "../../src/client/application/port-slices.js";
import { WEBUI_HOME_SESSION_KEY } from "../../src/client/application/state.js";
import { WEBUI_COMPOSER_HOME_KEY } from "../../src/client/features/composer/application/composer-history.js";
import type {
  WebuiClientMessageSender,
  WebuiClientSessionResumer,
} from "../../src/client/features/turn/contracts/execution-port.js";
import type { WebuiGoal } from "../../src/shared/contracts/goal.js";
import type { WebuiRuntimeEvent } from "../../src/shared/contracts/stream.js";

function goal(sessionId: string, objective: string): WebuiGoal {
  return {
    goalId: "goal-1",
    sessionId,
    objective,
    status: "active",
    createdAt: 1,
    updatedAt: 1,
    tokensUsed: 0,
    turnsUsed: 0,
    timeUsedSeconds: 0,
    tokenBudget: null,
    statusReason: null,
  };
}

/**
 * One host with what the four origins need and nothing else. The slices and the
 * turn capability port are cut from the same bag, the way production cuts both
 * from the one transport it holds.
 */
function host() {
  const createSession = vi.fn(async () => ({ sessionId: "s1" }));
  const sendMessage: WebuiClientMessageSender = vi.fn(async (_request, onFrame) => {
    onFrame({ dataJson: "[DONE]" });
  });
  const loadSessions = vi.fn(async () => ({ sessions: [], hasMore: false }));
  const loadSessionTree = vi.fn(async () => ({ sessions: [], hasMore: false }));
  const createGoal = vi.fn(async (request: { sessionId: string; objective: string }) =>
    goal(request.sessionId, request.objective),
  );
  const transport = { sendMessage, createSession, loadSessions, loadSessionTree };
  const app = createWebuiApplicationFixture({
    slices: createWebuiPortSlices(transport),
    turnCapabilities: transport,
    goalPort: { createGoal },
  });
  app.start({ initialSessionId: undefined });
  return { app, createSession, sendMessage, loadSessions, loadSessionTree, createGoal };
}

describe("the creation origins with nothing mounted", () => {
  it("ordinary send: one create, dispatch to the created session, catalogue refreshed", async () => {
    const { app, createSession, sendMessage, loadSessions, loadSessionTree } = host();
    app.composer.setDraft(WEBUI_COMPOSER_HOME_KEY, "start working");

    const outcome = await app.composerController.submit({
      draft: "start working",
      sending: false,
      goalEnabled: false,
      agentName: "minimax",
      createSessionWorkspaceDir: "/work/minimax-code",
      teamModeOff: true,
    });

    expect(outcome.kind).toBe("submitted");
    expect(createSession).toHaveBeenCalledTimes(1);
    expect(createSession).toHaveBeenCalledWith({
      name: "main",
      workspaceDir: "/work/minimax-code",
      teamModeOff: true,
    });
    // The first message is the created session's, and nothing reset the destination
    // the transfer had just protected.
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(vi.mocked(sendMessage).mock.calls[0]?.[0]).toMatchObject({
      id: "s1",
      content: "start working",
    });
    // Creation completion refreshes the supported catalogue reads, and it does so in
    // the use case — no shell callback took part.
    expect(loadSessions).toHaveBeenCalledTimes(1);
    expect(loadSessionTree).toHaveBeenCalledTimes(1);
    // The selection followed the committed result, and the submitted draft is gone
    // from the session it was adopted by.
    expect(app.store.getSelectedSessionId()).toBe("s1");
    expect(app.composer.readDraft("s1")).toBe("");
    expect(app.composer.readDraft(WEBUI_COMPOSER_HOME_KEY)).toBe("");
    app.dispose();
  });

  it("goal submission: one create, and the goal created on the created session", async () => {
    const { app, createSession, createGoal } = host();
    app.store.createSessionWriter({ kind: "home" }).setSending(true);
    // Goal mode is the composer store's, exactly as the UI sets it.
    app.composerController.setGoalMode(true);

    const outcome = await app.composerController.submit({
      draft: "ship the release",
      sending: false,
      goalEnabled: true,
      agentName: "minimax",
      createSessionWorkspaceDir: "/work/minimax-code",
      teamModeOff: true,
    });

    expect(outcome.kind).toBe("goal-updated");
    // The goal path creates through the same use case the send path does: one
    // create, and the home record moved onto its destination.
    expect(createSession).toHaveBeenCalledTimes(1);
    expect(app.store.hasSession(WEBUI_HOME_SESSION_KEY)).toBe(false);
    expect(app.store.readSession("s1").sending).toBe(true);
    // The created session holds no goal, so the objective is created on *its* owner
    // and committed there — the create-or-patch decision is the goal module's.
    expect(createGoal).toHaveBeenCalledWith({
      sessionId: "s1",
      objective: "ship the release",
    });
    expect(app.store.readSession("s1").goal?.objective).toBe("ship the release");
    expect(app.store.getSelectedSessionId()).toBe("s1");
    app.dispose();
  });

  it("plugin chat: one create and the same completion policy", async () => {
    const { app, createSession, loadSessions, loadSessionTree } = host();
    app.store.createSessionWriter({ kind: "home" }).setSending(true);
    app.composer.setDraft(WEBUI_COMPOSER_HOME_KEY, "half-written");

    // The rail's chat action submits the agent's name and nothing else. The use case
    // owns the completion; the shell only writes its own navigation effect after it.
    const outcome = await app.taskSessions.submit({ name: "reviewer" });

    expect(outcome.kind).toBe("created");
    if (outcome.kind !== "created") throw new Error("expected created");
    expect(outcome.transfer).toBe("transferred");
    expect(createSession).toHaveBeenCalledTimes(1);
    expect(createSession).toHaveBeenCalledWith({ name: "reviewer" });
    expect(app.store.readSession("s1").sending).toBe(true);
    expect(app.store.hasSession(WEBUI_HOME_SESSION_KEY)).toBe(false);
    // The composer's home slot moved with the record, and the draft went with it.
    expect(app.composer.readDraft("s1")).toBe("half-written");
    expect(app.composer.readDraft(WEBUI_COMPOSER_HOME_KEY)).toBe("");
    expect(loadSessions).toHaveBeenCalledTimes(1);
    expect(loadSessionTree).toHaveBeenCalledTimes(1);
    // Nothing selected it: a selection is composition's, and this origin's caller is
    // the shell, which is not mounted here.
    expect(app.store.getSelectedSessionId()).toBeUndefined();
    app.dispose();
  });

  it("rail New Task: the recorded choice is the workspace the next creation uses", async () => {
    const { app, createSession } = host();
    const boot = app.taskSessions.noteNavigation(undefined);
    app.store.createSessionWriter({ kind: "home" }).setSending(true);
    app.composer.setDraft(WEBUI_COMPOSER_HOME_KEY, "the old attempt");

    // 「新建任务」 with a project chosen: the home record is dropped, its incarnation
    // advances and the navigation claim moves, so a creation that started before
    // this point cannot adopt onto the home the user has already replaced (the
    // in-flight half is covered by the use case's own cases).
    const started = app.taskSessions.beginNewTask("/work/other");
    expect(started.workspaceDir).toBe("/work/other");
    expect(started.navigationEpoch).toBeGreaterThan(boot);
    expect(app.store.hasSession(WEBUI_HOME_SESSION_KEY)).toBe(false);

    // The next creation starts where the rail said it would.
    await app.taskSessions.submit({ workspaceDir: started.workspaceDir });
    expect(createSession).toHaveBeenCalledWith({
      name: "main",
      workspaceDir: "/work/other",
    });
    app.dispose();
  });

  it("keeps destination state that arrives from another client while creation is pending", async () => {
    let resolveCreate!: (value: { sessionId: string }) => void;
    let emit!: (event: WebuiRuntimeEvent) => void;
    const createSession = vi.fn(
      () => new Promise<{ sessionId: string }>((resolve) => { resolveCreate = resolve; }),
    );
    const resumeSession: WebuiClientSessionResumer = vi.fn(async (_request, onFrame) => {
      onFrame({
        dataJson: JSON.stringify({
          type: "agent_message",
          agent_message: { msg_id: "other-client-message", msg_content: "preserve me" },
        }),
      });
      await new Promise<void>(() => undefined);
    });
    const app = createWebuiApplication({
      openEventChannel: () => ({
        subscribe: (listener) => { emit = listener; return () => undefined; },
        close: () => undefined,
      }),
      turns: { resumeSession },
      turnCapabilities: { resumeSession },
      slices: createWebuiPortSlices({ createSession: createSession as never }),
    });
    app.start({ initialSessionId: undefined });
    app.store.createSessionWriter({ kind: "home" }).setSending(true);
    const creating = app.taskSessions.submit({ name: "main" });
    await Promise.resolve();

    // A second client starts the just-created destination and sends transcript
    // data while this client's create response is still pending.
    emit({
      type: "session.start",
      payload: { sessionId: "s1", turnId: "other-client-turn" },
      timestamp: 1,
      source: "other-client",
    });
    await Promise.resolve();
    expect(app.store.readSession("s1").stream.messages[0]?.answer).toBe("preserve me");
    resolveCreate({ sessionId: "s1" });

    await expect(creating).resolves.toMatchObject({ kind: "created", transfer: "target-exists" });
    expect(app.store.readSession("s1").sending).toBe(true);
    expect(app.store.readSession("s1").stream.phase).toBe("streaming");
    expect(app.store.readSession("s1").stream.subscription?.turnId).toBe("other-client-turn");
    expect(app.store.readSession("s1").stream.messages[0]?.answer).toBe("preserve me");
    expect(app.store.hasSession(WEBUI_HOME_SESSION_KEY)).toBe(true);
    app.dispose();
  });
});
