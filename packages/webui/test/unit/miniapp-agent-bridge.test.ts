// The Mini App page bridge, driven end to end without a browser.
//
// The page half is the script the proxy actually injects
// (`server/miniapp/bridge.ts`), executed in a `vm` context whose `window` is a
// two-window pair: the page's own, and the client's as its `parent`. The client
// half is the real host (`application/miniapp-agent-bridge.ts`). Frames travel the
// way they do in a browser — the page posts to its parent, the host posts back to
// the frame — so these cases exercise source and origin checks, request-id
// correlation, event delivery, cancellation, navigation fencing and teardown rather
// than a stub of them.
//
// On the other side of the host the commands are scripted, and the operations are
// driven through their real handlers against a scripted port, so what a case
// asserts is what reached the runtime: which caller, which generation, whether a
// listener was attached, and whether a run was aborted. The shown/closed lifecycle
// is driven through the application's real session store, and the approval rule at
// the end runs the runtime's real gateway — the component that decides whether a
// Mini App ask can be answered.
import vm from "node:vm";

import { describe, expect, it, vi } from "vitest";
import type {
  MiniAppAgentModelSelection,
  MiniAppAgentRunEvent,
  MiniAppAgentRunResult,
} from "@mavis/shared/miniapp-surface";

// The approval gateway is not one of the runtime package's published entry points,
// and this is the only way to exercise the rule the ticket's AC6 names without
// booting a whole runtime host: the module is imported directly, from a test, and
// nothing under `src/` reaches it.
import { createMiniAppAgentGateway } from "../../../local-runtime-v2/src/service/miniapp/agent/gateway.js";

import { miniAppPageBridge } from "../../src/server/miniapp/bridge.js";
import {
  createWebuiMiniAppAgentBridge,
  type WebuiMiniAppAgentBridgeHost,
} from "../../src/client/features/miniapp/application/miniapp-agent-bridge.js";
import { createWebuiSessionStore } from "../../src/client/application/session-store.js";
import { createMiniAppAgentConnections } from "../../src/server/miniapp/agent-connections.js";
import { createMiniAppAgentPanels } from "../../src/server/miniapp/agent-panels.js";
import { createMiniAppAgentRuns } from "../../src/server/miniapp/agent-runs.js";
import { createMiniAppAgentHandlerEntries } from "../../src/server/operation/handlers/miniapp-agent.js";
import { createMiniAppHandlerEntries } from "../../src/server/operation/handlers/miniapp.js";
import { createWebuiMiniAppWorkflows } from "../../src/client/features/miniapp/application/miniapp-workflows.js";
import type {
  WebuiMiniAppAgentCallRequest,
  WebuiMiniAppAgentTurnFrame,
  WebuiMiniAppAgentTurnRequest,
} from "../../src/shared/contracts/miniapp-agent.js";
import { WEBUI_MINIAPP_BRIDGE_AGENT_REQUEST } from "../../src/shared/contracts/miniapp-agent.js";
import type { WebuiMiniAppPortSlice } from "../../src/client/features/miniapp/application/miniapp-workflows.js";
import type { WebuiHarnessPort } from "../../src/runtime/port.js";

const VIEW_URL = "http://127.0.0.1:49152/";
const ORIGIN = "http://127.0.0.1:49152";
const PLUGIN = "demo.miniapp";
const HOST_SESSION = "session-host";
const MINI_SESSION = "session-mini";

interface PageHarness {
  readonly agent: Record<string, (...args: unknown[]) => Promise<unknown>>;
  /** Every frame the page posted to its parent, until `deliver` drains them. */
  readonly sentToParent: Record<string, unknown>[];
  /** Delivers a frame from the client into the page. */
  readonly deliver: (data: unknown) => void;
  /** The page's own window, which is also its parent's child. */
  readonly window: Record<string, unknown>;
}

/**
 * The proxy's real script, in a page-shaped context.
 *
 * Only what the script reads is provided: `window` with a `parent` it can post to,
 * the event listeners it registers, and the language built-ins it uses. Nothing
 * here stands in for the bridge's own logic.
 */
function openPage(): PageHarness {
  const listeners: ((event: { source: unknown; data: unknown }) => void)[] = [];
  const sentToParent: Record<string, unknown>[] = [];
  const pageWindow: Record<string, unknown> = {
    parent: {
      postMessage: (message: unknown) => {
        sentToParent.push(message as Record<string, unknown>);
      },
    },
    addEventListener: (type: string, listener: (event: never) => void) => {
      if (type === "message") listeners.push(listener as never);
    },
  };
  const context = vm.createContext({
    window: pageWindow,
    Map,
    Math,
    JSON,
    Error,
    Object,
    Date,
    Promise,
    console,
  });
  vm.runInContext(miniAppPageBridge().script, context);
  const mcode = pageWindow.mcode as {
    miniapp: { agent: Record<string, (...a: unknown[]) => Promise<unknown>> };
  };
  return {
    agent: mcode.miniapp.agent,
    sentToParent,
    window: pageWindow,
    deliver: (data) => {
      // `postMessage` structured-clones across the realm boundary, so a payload the
      // page built is a plain object of the *host's* realm when it arrives. The
      // clone here is that boundary: without it a reader that tests the prototype
      // would reject the page's own object for being foreign.
      const cloned = structuredClone(data);
      for (const listener of listeners) listener({ source: pageWindow.parent, data: cloned });
    },
  };
}

/** Carries every frame the page has posted so far to the host, once. */
function deliver(page: PageHarness, host: WebuiMiniAppAgentBridgeHost): void {
  const frames = [...page.sentToParent];
  page.sentToParent.length = 0;
  for (const data of frames) {
    // The same realm boundary in the other direction: what the host receives is a
    // clone of the page's object, not the page's object.
    host.handleMessage(
      { data: structuredClone(data), origin: ORIGIN, source: page.window },
      page.window,
    );
  }
}

/** Lets the promise chains a dispatch starts run to completion. */
async function settle(): Promise<void> {
  for (let tick = 0; tick < 20; tick += 1) await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
  for (let tick = 0; tick < 20; tick += 1) await Promise.resolve();
}

function turnResult(overrides: Partial<MiniAppAgentRunResult> = {}): MiniAppAgentRunResult {
  return {
    sessionId: MINI_SESSION,
    turnId: "turn-1",
    status: "finished",
    text: "done",
    ...overrides,
  };
}

interface Harness {
  readonly page: PageHarness;
  readonly host: WebuiMiniAppAgentBridgeHost;
  readonly hostFrames: Record<string, unknown>[];
  readonly calls: WebuiMiniAppAgentCallRequest[];
  readonly turns: WebuiMiniAppAgentTurnRequest[];
}

/** One page, one host, with scripted commands whose behaviour a case varies. */
function bridgeHarness(
  options: {
    readonly onWatch?: (
      request: WebuiMiniAppAgentTurnRequest,
      onFrame: (frame: WebuiMiniAppAgentTurnFrame) => void,
      onFailure: (error: Error) => void,
    ) => (() => void) | "sync-failure";
  } = {},
): Harness {
  const page = openPage();
  const hostFrames: Record<string, unknown>[] = [];
  const calls: WebuiMiniAppAgentCallRequest[] = [];
  const turns: WebuiMiniAppAgentTurnRequest[] = [];
  const host = createWebuiMiniAppAgentBridge({
    pluginId: PLUGIN,
    hostSessionId: HOST_SESSION,
    connection: 1,
    viewUrl: VIEW_URL,
    post: (message) => {
      hostFrames.push(message as Record<string, unknown>);
      page.deliver(message);
    },
    commands: {
      call: async (request) => {
        calls.push(request);
        return { ok: true, method: "cancel" } as never;
      },
      watchTurn: (request, onFrame, onFailure) => {
        turns.push(request);
        const watch = options.onWatch?.(request, onFrame, onFailure);
        if (watch === "sync-failure") {
          onFailure(
            Object.assign(new Error("runtime_unavailable"), { code: "runtime_unavailable" }),
          );
          return () => undefined;
        }
        return watch ?? (() => undefined);
      },
    },
  });
  return { page, host, hostFrames, calls, turns };
}

function agentPort(overrides: Partial<Record<string, unknown>> = {}): WebuiHarnessPort {
  return {
    runMiniAppAgentTurn: async () => turnResult(),
    answerMiniAppAgentQuestion: async () => turnResult(),
    replyMiniAppAgentPermission: async () => undefined,
    openMiniAppAgentSession: async () => ({ sessionId: MINI_SESSION, hostSessionId: HOST_SESSION }),
    panelOpenedMiniAppAgentSession: async () => undefined,
    panelClosedMiniAppAgentSession: async () => undefined,
    listMiniAppAgentModels: async () => ({
      models: [],
      default: { providerId: "p", modelId: "m" } satisfies MiniAppAgentModelSelection,
    }),
    listMiniAppAgentAgents: async () => ({ agents: [] }),
    listMiniAppAgentSessions: async () => ({ sessions: [] }),
    readMiniAppAgentSession: async () => undefined,
    createMiniAppAgentSession: async () => ({ sessionId: MINI_SESSION }),
    ...overrides,
  } as unknown as WebuiHarnessPort;
}

/** The three registries one service shares between its two handler sets. */
function registries() {
  return {
    connections: createMiniAppAgentConnections(),
    runs: createMiniAppAgentRuns(),
    panels: createMiniAppAgentPanels(),
  };
}

const BODY = {
  pluginId: PLUGIN,
  hostSessionId: HOST_SESSION,
  connection: 1,
  requestId: "req-1",
  method: "run" as const,
  observe: true,
  text: "hello",
};

describe("the page bridge's agent block", () => {
  it("carries a run's events and its settlement back to the page that asked", async () => {
    const harness = bridgeHarness({
      onWatch: (_request, onFrame) => {
        onFrame({
          kind: "event",
          event: {
            type: "turn.started",
            sessionId: MINI_SESSION,
            turnId: "turn-1",
            model: { providerId: "p", modelId: "m" },
          },
        });
        onFrame({
          kind: "event",
          event: { type: "text.delta", sessionId: MINI_SESSION, turnId: "turn-1", text: "hel" },
        });
        onFrame({ kind: "settled", result: turnResult() });
        return () => undefined;
      },
    });

    const seen: MiniAppAgentRunEvent[] = [];
    const running = harness.page.agent.run(
      { text: "hello" },
      { onEvent: (event: MiniAppAgentRunEvent) => seen.push(event) },
    );
    deliver(harness.page, harness.host);
    const result = await running;

    expect(harness.turns[0]?.text).toBe("hello");
    expect(harness.turns[0]?.observe).toBe(true);
    // The identity the page never supplied, resolved by the view.
    expect(harness.turns[0]?.pluginId).toBe(PLUGIN);
    expect(harness.turns[0]?.hostSessionId).toBe(HOST_SESSION);
    expect(harness.turns[0]?.connection).toBe(1);
    expect(seen.map((event) => event.type)).toEqual(["turn.started", "text.delta"]);
    expect(result).toMatchObject({ sessionId: MINI_SESSION, status: "finished", text: "done" });
  });

  it("ignores a message that did not come from the frame this view framed", () => {
    const watchTurn = vi.fn(() => () => undefined);
    const harness = bridgeHarness({ onWatch: watchTurn });
    const foreign = {
      type: "mcode:miniapp:agent-request",
      requestId: "r-1",
      method: "run",
      payload: { text: "hi" },
      observe: true,
    };
    // A second window on the same origin, and this page's own window under another.
    harness.host.handleMessage(
      { data: foreign, origin: ORIGIN, source: { other: true } },
      harness.page.window,
    );
    harness.host.handleMessage(
      { data: foreign, origin: "http://evil.test", source: harness.page.window },
      harness.page.window,
    );
    expect(watchTurn).not.toHaveBeenCalled();
  });

  it("answers a second run reusing a live page request id with busy", async () => {
    const harness = bridgeHarness();
    const first = harness.page.agent.run({ text: "one", requestId: "same" });
    deliver(harness.page, harness.host);
    expect(harness.host.inFlight()).toEqual(["same"]);

    // The page's own second call on its own live id: the duplicate guard is what
    // turns this into `busy` instead of a second watch on the same id.
    const second = harness.page.agent.run({ text: "two", requestId: "same" });
    deliver(harness.page, harness.host);
    await expect(second).rejects.toThrow("busy");

    expect(harness.turns).toHaveLength(1);
    expect(harness.host.inFlight()).toEqual(["same"]);
    first.catch(() => undefined);
  });

  it("answers an unknown page method instead of leaving its promise pending", async () => {
    const { page, host, hostFrames } = bridgeHarness();
    host.handleMessage(
      {
        data: {
          type: WEBUI_MINIAPP_BRIDGE_AGENT_REQUEST,
          requestId: "future-method-1",
          method: "futureMethod",
          payload: {},
          observe: false,
        },
        origin: ORIGIN,
        source: page.window,
      },
      page.window,
    );

    expect(hostFrames).toContainEqual({
      type: "mcode:miniapp:agent-result",
      requestId: "future-method-1",
      result: { ok: false, code: "invalid_request" },
    });
  });

  it("refuses a short call that reuses an in-flight turn request id", async () => {
    const harness = bridgeHarness();
    const running = harness.page.agent.run({ text: "one", requestId: "shared" });
    deliver(harness.page, harness.host);

    harness.host.handleMessage(
      {
        data: {
          type: "mcode:miniapp:agent-request",
          requestId: "shared",
          method: "models",
          payload: {},
          observe: false,
        },
        origin: ORIGIN,
        source: harness.page.window,
      },
      harness.page.window,
    );

    expect(harness.calls).toHaveLength(0);
    expect(harness.hostFrames.at(-1)).toMatchObject({
      type: "mcode:miniapp:agent-result",
      requestId: "shared",
      result: { ok: false, code: "busy" },
    });
    running.catch(() => undefined);
  });

  it("cancels a live turn through the service when the page asks", async () => {
    const harness = bridgeHarness();
    const running = harness.page.agent.run({ text: "long" }, { onEvent: () => undefined });
    deliver(harness.page, harness.host);

    harness.page.agent.cancel(harness.host.inFlight()[0] as string);
    deliver(harness.page, harness.host);
    await settle();

    expect(harness.calls.map((call) => call.method)).toEqual(["cancel"]);
    expect(harness.calls[0]?.requestId).toBe(harness.turns[0]?.requestId);
    running.catch(() => undefined);
  });

  it("frees the id when a watch fails synchronously, and accepts a retry", async () => {
    // Only the first attempt is refused: the retry is the case that would be stuck
    // as `busy` if the refusal had left its id in flight.
    let attempts = 0;
    const harness = bridgeHarness({
      onWatch: () => {
        attempts += 1;
        return attempts === 1 ? "sync-failure" : () => undefined;
      },
    });

    const refused = harness.page.agent.run({ text: "first", requestId: "retry" });
    deliver(harness.page, harness.host);
    await expect(refused).rejects.toThrow("runtime_unavailable");
    // The failure arrived before the watch returned its detach: nothing may stay in
    // flight, or the retry below would be answered `busy` for a turn never started.
    expect(harness.host.inFlight()).toEqual([]);

    const retried = harness.page.agent.run({ text: "second", requestId: "retry" });
    deliver(harness.page, harness.host);
    expect(harness.turns).toHaveLength(2);
    expect(harness.host.inFlight()).toEqual(["retry"]);
    retried.catch(() => undefined);
  });

  it("cancels the old generation's turns when the page navigates", async () => {
    const harness = bridgeHarness();
    const running = harness.page.agent.run({ text: "long" }, { onEvent: () => undefined });
    deliver(harness.page, harness.host);
    const requestId = harness.host.inFlight()[0] as string;

    harness.host.handleDocumentReplaced();
    await settle();

    expect(harness.calls.map((call) => call.method)).toEqual(["cancel"]);
    expect(harness.calls[0]?.requestId).toBe(requestId);
    expect(harness.host.inFlight()).toEqual([]);

    // The replacement document starts from nothing: an id it picks is free.
    const replacement = harness.page.agent.run(
      { text: "again", requestId: "fresh" },
      { onEvent: () => undefined },
    );
    deliver(harness.page, harness.host);
    expect(harness.host.inFlight()).toEqual(["fresh"]);
    running.catch(() => undefined);
    replacement.catch(() => undefined);
  });

  it("resolves the payload each call answers with, as the shipped page API does", async () => {
    const models = {
      models: [{ providerId: "p", modelId: "m", displayName: "M" }],
      default: { providerId: "p", modelId: "m" } satisfies MiniAppAgentModelSelection,
      host: { providerId: "p", modelId: "m" } satisfies MiniAppAgentModelSelection,
    };
    const agents = { agents: [{ name: "mavis", displayName: "Mavis", primary: true }] };
    const page = openPage();
    const host = createWebuiMiniAppAgentBridge({
      pluginId: PLUGIN,
      hostSessionId: HOST_SESSION,
      connection: 1,
      viewUrl: VIEW_URL,
      post: (message) => page.deliver(message),
      commands: {
        call: async (request) => {
          switch (request.method) {
            case "models":
              return { ok: true, method: "models", models };
            case "agents":
              return { ok: true, method: "agents", agents };
            case "create":
              return { ok: true, method: "create", sessionId: MINI_SESSION };
            case "open":
              return {
                ok: true,
                method: "open",
                sessionId: MINI_SESSION,
                hostSessionId: HOST_SESSION,
              };
            default:
              return { ok: true, method: "reply" };
          }
        },
        watchTurn: () => () => undefined,
      },
    });

    const askingModels = page.agent.models();
    deliver(page, host);
    // `const { models, default: model } = await …models()` must work as it does on
    // the desktop client: the envelope around the payload is the host's business.
    await expect(askingModels).resolves.toEqual(models);

    const askingAgents = page.agent.agents();
    deliver(page, host);
    await expect(askingAgents).resolves.toEqual(agents);

    const creating = page.agent.create();
    deliver(page, host);
    await expect(creating).resolves.toEqual({ sessionId: MINI_SESSION });

    const opening = page.agent.open(MINI_SESSION);
    deliver(page, host);
    await expect(opening).resolves.toBeUndefined();

    const replying = page.agent.reply({
      sessionId: MINI_SESSION,
      requestId: "perm-1",
      decision: "deny",
    });
    deliver(page, host);
    await expect(replying).resolves.toBeUndefined();
  });

  it("carries a permission decision and a questionnaire answer with the page's ids", async () => {
    const harness = bridgeHarness({
      onWatch: (_request, onFrame) => {
        onFrame({ kind: "settled", result: turnResult() });
        return () => undefined;
      },
    });

    const replied = harness.page.agent.reply({
      sessionId: MINI_SESSION,
      requestId: "perm-1",
      decision: "allowOnce",
    });
    deliver(harness.page, harness.host);
    await replied;

    const answered = harness.page.agent.answer(
      {
        sessionId: MINI_SESSION,
        questionId: "q-1",
        answers: [{ stepId: "s1", selectedOptionIds: ["yes"], selectedOther: false }],
      },
      { onEvent: () => undefined },
    );
    deliver(harness.page, harness.host);
    await answered;

    expect(harness.calls[0]).toMatchObject({
      method: "reply",
      targetSessionId: MINI_SESSION,
      questionRequestId: "perm-1",
      decision: "allowOnce",
    });
    expect(harness.turns[0]).toMatchObject({
      method: "answer",
      targetSessionId: MINI_SESSION,
      questionRequestId: "q-1",
      observe: true,
    });
  });
});

describe("the agent operations at the service boundary", () => {
  it("reaches the runtime with the launch's process generation as the caller", async () => {
    const { connections, runs, panels } = registries();
    connections.register({ pluginId: PLUGIN, runId: "gen-7" });
    const runMiniAppAgentTurn = vi.fn(async () => turnResult());
    const entries = createMiniAppAgentHandlerEntries(agentPort({ runMiniAppAgentTurn }), {
      connections,
      runs,
      panels,
    });
    const outcome = (await entries.get("watchMiniAppAgentTurn")!.handle({ requestId: "wire-1" }, BODY)) as {
      stream: { source: AsyncIterable<WebuiMiniAppAgentTurnFrame> };
    };
    const frames: WebuiMiniAppAgentTurnFrame[] = [];
    for await (const frame of outcome.stream.source) frames.push(frame);

    expect(runMiniAppAgentTurn).toHaveBeenCalledTimes(1);
    expect(runMiniAppAgentTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        caller: { pluginId: PLUGIN, runId: "gen-7", hostSessionId: HOST_SESSION },
        text: "hello",
      }),
    );
    expect(frames).toEqual([{ kind: "settled", result: turnResult() }]);
  });

  it("attaches a listener only when the page asked to observe", async () => {
    const { connections, runs, panels } = registries();
    connections.register({ pluginId: PLUGIN, runId: "gen-1" });
    const calls: Record<string, unknown>[] = [];
    const entries = createMiniAppAgentHandlerEntries(
      agentPort({
        runMiniAppAgentTurn: async (input: Record<string, unknown>) => {
          calls.push(input);
          return turnResult();
        },
      }),
      { connections, runs, panels },
    );
    const handle = entries.get("watchMiniAppAgentTurn")!;
    for (const observe of [true, false]) {
      const outcome = (await handle.handle(
        { requestId: `wire-${String(observe)}` },
        { ...BODY, observe, requestId: `req-${String(observe)}` },
      )) as { stream: { source: AsyncIterable<WebuiMiniAppAgentTurnFrame> } };
      for await (const frame of outcome.stream.source) void frame;
    }
    expect(calls[0]).toHaveProperty("onEvent");
    expect(calls[1]).not.toHaveProperty("onEvent");
  });

  it("refuses a stale presentation generation and never calls the runtime", async () => {
    const { connections, runs, panels } = registries();
    connections.register({ pluginId: PLUGIN, runId: "gen-1" });
    const runMiniAppAgentTurn = vi.fn();
    const entries = createMiniAppAgentHandlerEntries(agentPort({ runMiniAppAgentTurn }), {
      connections,
      runs,
      panels,
    });
    const outcome = (await entries
      .get("watchMiniAppAgentTurn")!
      .handle({ requestId: "wire" }, { ...BODY, connection: 99 })) as {
      stream: { source: AsyncIterable<WebuiMiniAppAgentTurnFrame> };
    };
    const frames: WebuiMiniAppAgentTurnFrame[] = [];
    for await (const frame of outcome.stream.source) frames.push(frame);
    expect(frames).toEqual([{ kind: "failure", code: "runtime_unavailable" }]);
    expect(runMiniAppAgentTurn).not.toHaveBeenCalled();
  });

  it("answers a documented code when the host cannot serve the method", async () => {
    const { connections, runs, panels } = registries();
    connections.register({ pluginId: PLUGIN, runId: "gen-1" });
    const entries = createMiniAppAgentHandlerEntries({} as WebuiHarnessPort, {
      connections,
      runs,
      panels,
    });
    const response = (await entries.get("miniAppAgentCall")!.handle(
      { requestId: "wire" },
      {
        pluginId: PLUGIN,
        hostSessionId: HOST_SESSION,
        connection: 1,
        requestId: "call-1",
        method: "models",
      },
    )) as { body: { ok: boolean; code?: string } };
    expect(response.body).toEqual({ ok: false, code: "runtime_unavailable" });
  });

  it("aborts a followed turn when the cancel operation names it", async () => {
    const { connections, runs, panels } = registries();
    connections.register({ pluginId: PLUGIN, runId: "gen-1" });
    const signals: (AbortSignal | undefined)[] = [];
    const entries = createMiniAppAgentHandlerEntries(
      agentPort({
        runMiniAppAgentTurn: ({ signal }: { signal?: AbortSignal }) =>
          new Promise((_resolve, reject) => {
            signals.push(signal);
            signal?.addEventListener("abort", () =>
              reject(Object.assign(new Error("aborted"), { code: "REQUEST_CANCELLED" })),
            );
          }),
      }),
      { connections, runs, panels },
    );

    const outcome = (await entries.get("watchMiniAppAgentTurn")!.handle({ requestId: "wire" }, BODY)) as {
      stream: { source: AsyncIterable<WebuiMiniAppAgentTurnFrame> };
    };
    const frames: WebuiMiniAppAgentTurnFrame[] = [];
    const consuming = (async () => {
      for await (const frame of outcome.stream.source) frames.push(frame);
    })();
    await settle();
    expect(runs.size()).toBe(1);

    const cancelled = (await entries.get("miniAppAgentCall")!.handle(
      { requestId: "wire-2" },
      {
        pluginId: PLUGIN,
        hostSessionId: HOST_SESSION,
        connection: 1,
        requestId: BODY.requestId,
        method: "cancel",
      },
    )) as { body: { ok: boolean; method?: string } };

    await consuming;
    expect(cancelled.body).toEqual({ ok: true, method: "cancel" });
    expect(signals[0]?.aborted).toBe(true);
    // The settlement is the abort, not a clean result, and the id is released.
    expect(frames).toEqual([{ kind: "failure", code: "cancelled" }]);
    expect(runs.size()).toBe(0);
  });
});

describe("the shown presentation", () => {
  function portWith(calls: WebuiMiniAppAgentCallRequest[]): WebuiMiniAppPortSlice {
    return {
      listMiniApps: async () => ({ miniApps: [] }),
      openMiniApp: async ({ pluginId }) => ({
        pluginId,
        viewUrl: VIEW_URL,
        connection: 1,
      }),
      stopMiniApp: async () => ({ success: true as const }),
      miniAppAgentCall: async (request) => {
        calls.push(request);
        if (request.method === "open") {
          return {
            ok: true,
            method: "open",
            sessionId: request.targetSessionId ?? "",
            hostSessionId: HOST_SESSION,
          };
        }
        return { ok: true, method: request.method as "panelOpened" };
      },
    } as WebuiMiniAppPortSlice;
  }

  /** The application's real selection owner: what a rail click ends up calling. */
  function selectedStore() {
    const store = createWebuiSessionStore();
    return {
      store,
      selection: {
        current: () => store.getSelectedSessionId(),
        subscribe: store.subscribe,
      },
    };
  }

  it("closes the lease when the rail selects another session, and reopens on return", async () => {
    const { store, selection } = selectedStore();
    const calls: WebuiMiniAppAgentCallRequest[] = [];
    const workflows = createWebuiMiniAppWorkflows({ port: portWith(calls), selection });

    store.select(MINI_SESSION);
    expect(await workflows.awaitSelection(MINI_SESSION)).toBe(true);
    await workflows.reportShown({
      pluginId: PLUGIN,
      sessionId: MINI_SESSION,
      hostSessionId: HOST_SESSION,
      connection: 1,
    });
    expect(calls.map((call) => call.method)).toEqual(["panelOpened"]);

    // The rail's own path: `selectSession` → `application.select` → `store.select`.
    store.select("another-session");
    await settle();
    expect(calls.map((call) => call.method)).toEqual(["panelOpened", "panelClosed"]);
    expect(workflows.getSnapshot().agentShown).toBeUndefined();
    // The workspace tab unmount follows the rail change. It must not erase the
    // resting record that lets the same session become answerable on return.
    workflows.releaseShown(PLUGIN);
    expect(workflows.getSnapshot().agentResting?.sessionId).toBe(MINI_SESSION);

    // Coming back is the rail's own path too: the page is not asked again, the
    // business reports the session it remembered — without which the runtime would
    // keep denying that session's asks while the rail shows it.
    store.select(MINI_SESSION);
    await settle();
    expect(calls.map((call) => call.method)).toEqual([
      "panelOpened",
      "panelClosed",
      "panelOpened",
    ]);
    expect(workflows.getSnapshot().agentShown?.sessionId).toBe(MINI_SESSION);

    // A lease released for good is not revived by a later selection: the page is
    // gone, so nothing would be on screen.
    workflows.releaseShown(PLUGIN);
    await settle();
    store.select("another-session");
    await settle();
    store.select(MINI_SESSION);
    await settle();
    expect(calls.filter((call) => call.method === "panelOpened")).toHaveLength(2);
    expect(workflows.getSnapshot().agentShown).toBeUndefined();
  });

  it("drops the remembered session when the runtime refuses to be told again", async () => {
    const { store, selection } = selectedStore();
    const calls: WebuiMiniAppAgentCallRequest[] = [];
    let refusals = 0;
    const port = {
      ...portWith(calls),
      miniAppAgentCall: async (request: WebuiMiniAppAgentCallRequest) => {
        calls.push(request);
        if (request.method === "panelOpened" && refusals > 0) {
          return { ok: false as const, code: "runtime_unavailable" as const };
        }
        if (request.method === "panelOpened") return { ok: true as const, method: "panelOpened" as const };
        return { ok: true as const, method: request.method as "panelClosed" };
      },
    } as WebuiMiniAppPortSlice;
    const workflows = createWebuiMiniAppWorkflows({ port, selection });

    store.select(MINI_SESSION);
    await workflows.reportShown({
      pluginId: PLUGIN,
      sessionId: MINI_SESSION,
      hostSessionId: HOST_SESSION,
      connection: 1,
    });
    refusals = 1;

    // Leaving keeps the record; coming back is refused by the runtime.
    store.select("another-session");
    await settle();
    store.select(MINI_SESSION);
    await settle();
    const afterRefusal = calls.length;
    expect(calls.filter((call) => call.method === "panelOpened")).toHaveLength(2);
    expect(workflows.getSnapshot().agentResting).toBeUndefined();

    // Once dropped, further snapshot changes do not keep asking.
    store.select("another-session");
    await settle();
    store.select(MINI_SESSION);
    await settle();
    expect(calls.length).toBe(afterRefusal);
    expect(workflows.getSnapshot().agentShown).toBeUndefined();
  });

  it("swallows a transport failure while re-reporting, instead of asking forever", async () => {
    const { store, selection } = selectedStore();
    const calls: WebuiMiniAppAgentCallRequest[] = [];
    let failing = false;
    const port = {
      ...portWith(calls),
      miniAppAgentCall: async (request: WebuiMiniAppAgentCallRequest) => {
        calls.push(request);
        // The socket is gone for the re-report. An unhandled rejection here would
        // fail this file, so the assertion is also the absence of one.
        if (failing && request.method === "panelOpened") throw new Error("socket closed");
        return { ok: true as const, method: request.method as "panelOpened" };
      },
    } as WebuiMiniAppPortSlice;
    const workflows = createWebuiMiniAppWorkflows({ port, selection });

    store.select(MINI_SESSION);
    await workflows.reportShown({
      pluginId: PLUGIN,
      sessionId: MINI_SESSION,
      hostSessionId: HOST_SESSION,
      connection: 1,
    });
    failing = true;

    store.select("another-session");
    await settle();
    const afterLeave = calls.length;

    // Coming back re-reports, and that report rejects at the transport.
    store.select(MINI_SESSION);
    await settle();

    // The claim is dropped rather than retried on every later notification.
    expect(workflows.getSnapshot().agentResting).toBeUndefined();
    expect(workflows.getSnapshot().agentShown).toBeUndefined();
    store.select("another-session");
    await settle();
    store.select(MINI_SESSION);
    await settle();
    expect(calls.length).toBe(afterLeave + 1);
  });

  it("does not claim a session the person left while the report was in flight", async () => {
    const { store, selection } = selectedStore();
    const calls: WebuiMiniAppAgentCallRequest[] = [];
    let hold = false;
    let release: (() => void) | undefined;
    const port = {
      ...portWith(calls),
      miniAppAgentCall: async (request: WebuiMiniAppAgentCallRequest) => {
        calls.push(request);
        if (hold && request.method === "panelOpened") {
          await new Promise<void>((resolve) => {
            release = resolve;
          });
        }
        return { ok: true as const, method: request.method as "panelOpened" };
      },
    } as WebuiMiniAppPortSlice;
    const workflows = createWebuiMiniAppWorkflows({ port, selection });

    store.select(MINI_SESSION);
    await workflows.reportShown({
      pluginId: PLUGIN,
      sessionId: MINI_SESSION,
      hostSessionId: HOST_SESSION,
      connection: 1,
    });
    hold = true;

    store.select("another-session");
    await settle();
    // The re-report for the return trip is now in flight.
    store.select(MINI_SESSION);
    await settle();
    // ...and the person leaves again before the runtime answers.
    store.select("another-session");
    await settle();
    release?.();
    await settle();

    // The runtime was told "shown", so it is told "closed" as well; nothing records
    // a session the rail is not showing as answerable.
    expect(calls.filter((call) => call.method === "panelClosed")).toHaveLength(2);
    expect(workflows.getSnapshot().agentShown).toBeUndefined();
    // The page still wants it, so returning is still a claim.
    expect(workflows.getSnapshot().agentResting?.sessionId).toBe(MINI_SESSION);
  });

  it("closes an initial shown report that finishes after the view unmounts", async () => {
    const { store, selection } = selectedStore();
    const calls: WebuiMiniAppAgentCallRequest[] = [];
    let release: (() => void) | undefined;
    const port = {
      ...portWith(calls),
      miniAppAgentCall: async (request: WebuiMiniAppAgentCallRequest) => {
        calls.push(request);
        if (request.method === "panelOpened") {
          await new Promise<void>((resolve) => {
            release = resolve;
          });
        }
        return { ok: true as const, method: request.method as "panelOpened" | "panelClosed" };
      },
    } as WebuiMiniAppPortSlice;
    const workflows = createWebuiMiniAppWorkflows({ port, selection });
    store.select(MINI_SESSION);

    const reporting = workflows.reportShown({
      pluginId: PLUGIN,
      sessionId: MINI_SESSION,
      hostSessionId: HOST_SESSION,
      connection: 1,
    });
    await settle();
    workflows.releaseShown(PLUGIN);
    release?.();
    await reporting;

    expect(calls.map((call) => call.method)).toEqual(["panelOpened", "panelClosed"]);
    expect(workflows.getSnapshot().agentShown).toBeUndefined();
  });

  it("keeps the panels it must close when the stop itself fails", async () => {
    const { connections, runs, panels } = registries();
    connections.register({ pluginId: PLUGIN, runId: "gen-1" });
    const closed: string[] = [];
    const port = {
      listMiniApps: async () => ({ miniApps: [] }),
      openMiniApp: async () => {
        throw new Error("not used");
      },
      // The runtime refuses to stop: its listener stays, so a retry must still know
      // which panels to close.
      stopMiniApp: async () => {
        throw new Error("stop failed");
      },
      panelClosedMiniAppAgentSession: async (input: { sessionId: string }) => {
        closed.push(input.sessionId);
      },
    } as unknown as WebuiHarnessPort;
    const entries = createMiniAppHandlerEntries(port, { connections, panels, runs });
    const agentEntries = createMiniAppAgentHandlerEntries(agentPort(), {
      connections,
      runs,
      panels,
    });

    // A page shows a session, then the stop fails.
    await agentEntries.get("miniAppAgentCall")!.handle(
      { requestId: "wire-1" },
      {
        pluginId: PLUGIN,
        hostSessionId: HOST_SESSION,
        connection: 1,
        requestId: "call-1",
        method: "panelOpened",
        targetSessionId: MINI_SESSION,
      },
    );
    expect(panels.forPlugin(PLUGIN)).toHaveLength(1);

    await expect(
      entries.get("stopMiniApp")!.handle({ requestId: "wire-2" }, { pluginId: PLUGIN }),
    ).rejects.toThrow("stop failed");

    expect(closed).toEqual([MINI_SESSION]);
    // Still recorded, so the retry closes it rather than leaving the runtime's
    // record stale for the plugin's next start.
    expect(panels.forPlugin(PLUGIN)).toHaveLength(1);
  });

  it("waits for the selection instead of claiming it", async () => {
    const { store, selection } = selectedStore();
    const workflows = createWebuiMiniAppWorkflows({ port: portWith([]), selection });
    const waiting = workflows.awaitSelection(MINI_SESSION, 50);
    store.select(MINI_SESSION);
    await expect(waiting).resolves.toBe(true);

    await expect(workflows.awaitSelection("elsewhere", 10)).resolves.toBe(false);
  });

  it("does not count a session the runtime refused as shown", async () => {
    const calls: WebuiMiniAppAgentCallRequest[] = [];
    const port = {
      ...portWith(calls),
      miniAppAgentCall: async (request: WebuiMiniAppAgentCallRequest) => {
        calls.push(request);
        return { ok: false as const, code: "not_permitted" as const };
      },
    } as WebuiMiniAppPortSlice;
    const workflows = createWebuiMiniAppWorkflows({ port });
    await workflows.reportShown({
      pluginId: PLUGIN,
      sessionId: MINI_SESSION,
      hostSessionId: HOST_SESSION,
      connection: 1,
    });
    expect(workflows.getSnapshot().agentShown).toBeUndefined();
  });
});

describe("the approval rule the runtime applies", () => {
  /** The runtime's real gateway, bound to the smallest set of ports it needs. */
  function realGateway() {
    const gateway = createMiniAppAgentGateway({
      dataDir: "/tmp/webui-miniapp-gateway",
      logger: { info: () => undefined, warn: () => undefined },
      nowMs: () => 1_000,
    });
    gateway.bind({
      createSession: async () => ({ sessionId: MINI_SESSION }),
      defaultSessionModel: async () => ({
        selection: { providerId: "p", modelId: "m" } satisfies MiniAppAgentModelSelection,
      }),
      resolveModel: async () => ({ providerId: "p", modelId: "m" }),
      listModels: async () => [],
      listAgents: async () => [],
      readSessionModel: async () => ({ providerId: "p", modelId: "m" }),
      setSessionModel: async () => undefined,
      getOwner: async () => PLUGIN,
      resolveMiniAppRoot: async (sessionId: string) => ({
        rootSessionId: sessionId,
        pluginId: PLUGIN,
      }),
      runTurn: () => new Promise(() => undefined),
      answerQuestion: () => new Promise(() => undefined),
      replyPermission: async () => "processed",
      subscribePermissionAsks: () => () => undefined,
    } as never);
    gateway.registerArena({
      pluginId: PLUGIN,
      processGeneration: "gen-1",
      policy: { kind: "allowlist", capabilities: ["session.run"], maxConcurrent: 1 },
    });
    return gateway;
  }

  const LINEAGE = { miniApp: true } as const;

  it("denies an ask while nothing shows the session, and answers once a panel does", async () => {
    const gateway = realGateway();
    expect(await gateway.shouldDenyApproval(MINI_SESSION, LINEAGE)).toBe(true);

    gateway.panelOpened({ sessionId: MINI_SESSION, hostSessionId: HOST_SESSION });
    expect(await gateway.shouldDenyApproval(MINI_SESSION, LINEAGE)).toBe(false);

    gateway.panelClosed({ sessionId: MINI_SESSION, hostSessionId: HOST_SESSION });
    expect(await gateway.shouldDenyApproval(MINI_SESSION, LINEAGE)).toBe(true);
  });

  it("counts a run that is still listening even with no panel on screen", async () => {
    const gateway = realGateway();
    const run = gateway.run(
      { pluginId: PLUGIN, processGeneration: "gen-1", source: "page", hostSessionId: HOST_SESSION },
      // Continuing a session takes the stored model, so no host session is resolved.
      { text: "long", sessionId: MINI_SESSION },
      { onEvent: () => undefined },
    );
    run.catch(() => undefined);
    await settle();
    expect(await gateway.shouldDenyApproval(MINI_SESSION, LINEAGE)).toBe(false);
  });

  it("stops answering after a stop, and a restart cannot revive the old panel", async () => {
    const gateway = realGateway();
    const { connections, runs, panels } = registries();
    connections.register({ pluginId: PLUGIN, runId: "gen-1" });

    const agentEntries = createMiniAppAgentHandlerEntries(
      agentPort({
        panelOpenedMiniAppAgentSession: async (input: { sessionId: string; hostSessionId: string }) =>
          gateway.panelOpened(input),
        panelClosedMiniAppAgentSession: async (input: { sessionId: string; hostSessionId: string }) =>
          gateway.panelClosed(input),
        runMiniAppAgentTurn: ({ signal }: { signal?: AbortSignal }) =>
          new Promise((_resolve, reject) => {
            signal?.addEventListener("abort", () =>
              reject(Object.assign(new Error("aborted"), { code: "REQUEST_CANCELLED" })),
            );
          }),
      }),
      { connections, runs, panels },
    );

    // A page shows a session and starts a turn it is listening to.
    await agentEntries.get("miniAppAgentCall")!.handle(
      { requestId: "wire-1" },
      {
        pluginId: PLUGIN,
        hostSessionId: HOST_SESSION,
        connection: 1,
        requestId: "call-1",
        method: "panelOpened",
        targetSessionId: MINI_SESSION,
      },
    );
    const turn = (await agentEntries
      .get("watchMiniAppAgentTurn")!
      .handle({ requestId: "wire-2" }, BODY)) as {
      stream: { source: AsyncIterable<WebuiMiniAppAgentTurnFrame> };
    };
    const frames: WebuiMiniAppAgentTurnFrame[] = [];
    const consuming = (async () => {
      for await (const frame of turn.stream.source) frames.push(frame);
    })();
    await settle();
    expect(await gateway.shouldDenyApproval(MINI_SESSION, LINEAGE)).toBe(false);

    // A stop: the panel record is closed with the runtime before the generation is
    // revoked, and the followed turn is aborted.
    const stopEntries = createMiniAppHandlerEntries(
      {
        listMiniApps: async () => ({ miniApps: [] }),
        openMiniApp: async () => {
          throw new Error("not used");
        },
        stopMiniApp: async () => undefined,
        panelClosedMiniAppAgentSession: async (input: {
          sessionId: string;
          hostSessionId: string;
        }) => gateway.panelClosed(input),
      } as unknown as WebuiHarnessPort,
      { connections, panels, runs },
    );
    await stopEntries.get("stopMiniApp")!.handle({ requestId: "wire-3" }, { pluginId: PLUGIN });
    await consuming;

    expect(frames).toEqual([{ kind: "failure", code: "cancelled" }]);
    expect(await gateway.shouldDenyApproval(MINI_SESSION, LINEAGE)).toBe(true);

    // Restart: a new generation, and the old connection cannot act as this plugin.
    connections.register({ pluginId: PLUGIN, runId: "gen-2" });
    const stale = (await agentEntries.get("miniAppAgentCall")!.handle(
      { requestId: "wire-4" },
      {
        pluginId: PLUGIN,
        hostSessionId: HOST_SESSION,
        connection: 1,
        requestId: "call-2",
        method: "panelOpened",
        targetSessionId: MINI_SESSION,
      },
    )) as { body: { ok: boolean; code?: string } };
    expect(stale.body).toEqual({ ok: false, code: "runtime_unavailable" });
    expect(await gateway.shouldDenyApproval(MINI_SESSION, LINEAGE)).toBe(true);
  });
});
