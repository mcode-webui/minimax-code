// Protocol compatibility for every operation (stage 3, part B).
//
// The old side is **the frozen pre-refactor implementation itself**, copied
// byte-for-byte from the original baseline commit into
// `./legacy-protocol/` (see `./legacy-protocol/README.md` for provenance). It is
// not an approximation: the operation roster comes from its own registry, the
// accept/reject decision comes from its own descriptor validators, and the
// frames come from its own dispatcher. An earlier revision of this file
// reconstructed the baseline validators by hand, which made the oracle accept
// bodies the real baseline rejected (`version` with `body: null`,
// `archiveSession` with `archived: "yes"`, `getSession` with `{}`) — the
// canary test below pins that regression.
//
// The two sides run against *separately created* deterministic synthetic ports
// — same request ids, same generated values, same argument shapes — and a fake
// open WebSocket records the exact strings `send()` received. Frames are
// compared as UTF-8 bytes with `Buffer.from(a, "utf8").equals(...)`, never as
// parsed-and-re-sorted objects, because field order, omitted fields and
// undefined serialisation are part of the contract. Capability calls and the
// abort signal each capability received are compared too.
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { WebSocket } from "ws";

import { WebuiErrorCode, WEBUI_PROTOCOL_VERSION } from "../../src/shared/envelope.js";
import type { WebuiHarnessPort } from "../../src/runtime/port.js";
import { createOperationRegistry } from "../../src/server/index.js";
import { dispatchWebuiFrame } from "../../src/server/operation/operation-dispatch.js";
import {
  DEDICATED_OPERATION_NAMES,
  WEBUI_OPERATION_BINDINGS,
} from "../../src/server/operation/bind-handlers.js";
import { runWebuiCommand } from "../../src/runtime/commands/runner.js";
import {
  createOperationRegistry as createLegacyOperationRegistry,
} from "./legacy-protocol/server/operation/operations.js";
import {
  dispatchWebuiFrame as dispatchLegacyWebuiFrame,
} from "./legacy-protocol/server/operation/operation-dispatch.js";

type LegacyRegistry = ReturnType<typeof createLegacyOperationRegistry>;
type LegacyPort = Parameters<typeof createLegacyOperationRegistry>[0];
type LegacyTerminal = Parameters<typeof createLegacyOperationRegistry>[1];

/** An async iterable that yields nothing; deterministic for both sides. */
function emptyStream(): AsyncIterable<never> {
  return (async function* empty(): AsyncGenerator<never> {})();
}

interface Call {
  readonly method: string;
  readonly args: readonly unknown[];
}

/**
 * Replace an abort signal with a stable label so the two sides' recorded call
 * arguments stay comparable without sharing an object identity. `injected` is
 * the signal the dispatcher was told to hand the handler: a capability that
 * received it records `<injected-signal>`, so a side that passed a different
 * signal (or none) cannot match.
 */
function normaliseArg(arg: unknown, injected: AbortSignal | undefined): unknown {
  if (arg instanceof AbortSignal)
    return arg === injected ? "<injected-signal>" : "<foreign-signal>";
  return arg;
}

function normaliseArgs(
  args: readonly unknown[],
  injected: AbortSignal | undefined,
): readonly unknown[] {
  return args.map((arg) => normaliseArg(arg, injected));
}

/** A port whose every method records its call and returns a fixed value. */
interface RecordingPort {
  readonly port: WebuiHarnessPort;
  readonly calls: Call[];
}

interface PortPlan {
  /**
   * Substitute one member before the default behaviour applies. A key present
   * with value `undefined` models an **absent** optional capability; a key
   * present with a non-function value models a **non-callable** one.
   */
  readonly override?: Readonly<Record<string, unknown>>;
  /** A live async iterable for the streaming capabilities. */
  readonly stream?: () => AsyncIterable<unknown>;
  /** The signal the dispatcher hands the handler, used for argument labels. */
  readonly injectedSignal?: AbortSignal | undefined;
}

function recordingPort(plan: PortPlan = {}): RecordingPort {
  const calls: Call[] = [];
  const port = new Proxy(
    {},
    {
      get(_target, key) {
        if (typeof key !== "string") return undefined;
        if (plan.override && Object.prototype.hasOwnProperty.call(plan.override, key))
          return plan.override[key];
        const record = (...args: readonly unknown[]): void => {
          calls.push({ method: key, args: normaliseArgs(args, plan.injectedSignal) });
        };
        if (key === "version")
          return (...args: readonly unknown[]) => {
            record(...args);
            return { version: "0.0.0-fixed", protocolVersion: 1 };
          };
        // Streams return a live async iterable, not a promise. The data
        // streams wrap it through the session-stream projection; the event
        // watcher returns it directly.
        if (key === "watchEvents")
          return (...args: readonly unknown[]) => {
            record(...args);
            return plan.stream?.() ?? emptyStream();
          };
        if (key === "sendMessage" || key === "resumeSession")
          return (...args: readonly unknown[]) => {
            record(...args);
            return Promise.resolve({ ok: true, source: plan.stream?.() ?? emptyStream() });
          };
        // `runCommand` is a port capability whose implementation is the command
        // interpreter over the rest of the port. The scripted port models it the
        // same way the runtime adapter does, so both registries drive identical
        // capability calls and the comparison stays a wire comparison.
        if (key === "runCommand")
          return (request: unknown) =>
            runWebuiCommand(port as unknown as WebuiHarnessPort, request as never);
        return (...args: readonly unknown[]) => {
          record(...args);
          return Promise.resolve({ method: key, args });
        };
      },
    },
  ) as unknown as WebuiHarnessPort;
  return { port, calls };
}

/** A terminal adapter whose every method records its call and returns a fixed value. */
interface RecordingTerminal {
  readonly terminal: LegacyTerminal;
  readonly calls: Call[];
}

function recordingTerminal(injectedSignal?: AbortSignal): RecordingTerminal {
  const calls: Call[] = [];
  const record = (method: string, args: readonly unknown[]) => {
    calls.push({ method, args: normaliseArgs(args, injectedSignal) });
  };
  const terminal = {
    create(workspaceDir: string) {
      record("terminal.create", [workspaceDir]);
      return { terminalId: "t1", status: "running" as const, output: "" };
    },
    list() {
      record("terminal.list", []);
      return [{ terminalId: "t1", status: "running" as const, output: "" }];
    },
    write(terminalId: string, data: string) {
      record("terminal.write", [terminalId, data]);
      return { success: true as const };
    },
    resize(terminalId: string, cols: number, rows: number) {
      record("terminal.resize", [terminalId, cols, rows]);
      return { success: true as const };
    },
    dispose(terminalId: string) {
      record("terminal.dispose", [terminalId]);
      return { success: true as const };
    },
    watch(terminalId: string, signal?: AbortSignal) {
      record("terminal.watch", [terminalId, signal]);
      return emptyStream();
    },
    disposeBySession() {
      record("terminal.disposeBySession", []);
    },
  } as unknown as LegacyTerminal;
  return { terminal, calls };
}

interface RecordingSocket {
  readonly readyState: number;
  readonly OPEN: number;
  readonly sent: string[];
  send(payload: string): void;
}

function recordingSocket(): RecordingSocket {
  const socket: RecordingSocket = {
    readyState: 1,
    OPEN: 1,
    sent: [],
    send(payload: string) {
      socket.sent.push(payload);
    },
  };
  return socket;
}

type Side = "baseline" | "production";

interface SideOptions {
  readonly plan?: PortPlan;
  readonly terminal?: boolean;
  readonly signal?: AbortSignal;
  readonly accepting?: boolean;
  /** Replaces `send` on the recording socket (socket-close abort fixtures). */
  readonly onSend?: (payload: string) => void;
}

interface SideRun {
  readonly sent: readonly string[];
  readonly calls: readonly Call[];
}

/** One dispatch of one frame through one independently created side. */
async function runSide(side: Side, frame: unknown, options: SideOptions = {}): Promise<SideRun> {
  const recordedPort = recordingPort({ ...options.plan, injectedSignal: options.signal });
  const recordedTerminal = recordingTerminal(options.signal);
  const terminal = options.terminal === false ? undefined : recordedTerminal.terminal;
  const getSignal = (): AbortSignal | undefined => options.signal;
  const socket = recordingSocket();
  if (options.onSend) {
    const send = socket.send.bind(socket);
    socket.send = (payload: string) => {
      send(payload);
      options.onSend?.(payload);
    };
  }
  if (side === "baseline") {
    const registry: LegacyRegistry = createLegacyOperationRegistry(
      recordedPort.port as unknown as LegacyPort,
      terminal,
    );
    await dispatchLegacyWebuiFrame(
      socket as unknown as WebSocket,
      frame,
      registry,
      options.accepting ?? true,
      getSignal,
    );
  } else {
    const registry = createOperationRegistry(
      recordedPort.port,
      terminal as unknown as Parameters<typeof createOperationRegistry>[1],
    );
    await dispatchWebuiFrame(
      socket as unknown as WebSocket,
      frame,
      registry,
      options.accepting ?? true,
      getSignal,
    );
  }
  return { sent: socket.sent, calls: [...recordedPort.calls, ...recordedTerminal.calls] };
}

function describeFrames(frames: readonly string[]): string {
  return frames.map((frame, index) => `  [${index}] ${frame}`).join("\n");
}

/** Byte comparison of the dispatched frames — never a parsed re-serialisation. */
function assertFrameBytesEqual(
  baseline: readonly string[],
  production: readonly string[],
  label: string,
): void {
  assert.equal(
    baseline.length,
    production.length,
    `${label}: frame count diverged (baseline ${baseline.length}, production ${production.length})\nbaseline:\n${describeFrames(baseline)}\nproduction:\n${describeFrames(production)}`,
  );
  for (let index = 0; index < baseline.length; index += 1) {
    const a = baseline[index] ?? "";
    const b = production[index] ?? "";
    assert.ok(
      Buffer.from(a, "utf8").equals(Buffer.from(b, "utf8")),
      `${label}: frame ${index} diverged\nbaseline:  ${a}\nproduction: ${b}`,
    );
  }
}

/** Run one frame through both sides and require identical bytes and calls. */
async function compareFrame(
  label: string,
  frame: unknown,
  options: SideOptions = {},
): Promise<void> {
  const baseline = await runSide("baseline", frame, options);
  const production = await runSide("production", frame, options);
  assertFrameBytesEqual(baseline.sent, production.sent, label);
  assert.deepEqual(baseline.calls, production.calls, `${label}: capability calls diverged`);
}

const MISSING_BODY = Symbol("body key omitted");

function requestFrame(operation: string, body: unknown): unknown {
  const frame: Record<string, unknown> = {
    protocolVersion: WEBUI_PROTOCOL_VERSION,
    kind: "request",
    requestId: "req-1",
    operation,
  };
  if (body !== MISSING_BODY) frame.body = body;
  return frame;
}

// `browseWorkspaceDirs` reads the real filesystem, so the comparison needs a
// directory whose contents cannot change between the two calls. An empty
// directory created for this run lists deterministically for both sides.
const EMPTY_BROWSE_DIR = mkdtempSync(join(os.tmpdir(), "webui-wire-browse-"));

/** One valid request body per operation, so the handler (not the validator) runs. */
const VALID_BODIES: Readonly<Record<string, unknown>> = {
  version: undefined,
  listSessions: { name: "main" },
  listVisibleProjects: {},
  getSessionTree: { name: "main" },
  createSession: { name: "main" },
  getSession: { id: "s1" },
  getActiveTurn: { id: "s1" },
  getSessionDiff: { id: "s1" },
  getTurnDiff: { id: "s1" },
  revertTurnDiff: { id: "s1" },
  reapplyTurnDiff: { id: "s1" },
  getSessionRewindPreview: { id: "s1", userMessageId: "u1" },
  rewindSession: { id: "s1", userMessageId: "u1", clientRequestId: "c1" },
  editSessionMessage: { id: "s1", userMessageId: "u1", clientRequestId: "c1", content: "hi" },
  archiveSession: { id: "s1" },
  deleteSession: { id: "s1" },
  updateSession: { id: "s1", title: "title" },
  getSessionForkOptions: { id: "s1" },
  forkSession: { id: "s1", clientRequestId: "c1", useSuggestedTitle: true, createIsolatedWorktree: false },
  isGoalEnabled: undefined,
  getGoal: { sessionId: "s1" },
  createGoal: { sessionId: "s1", objective: "objective" },
  patchGoal: { sessionId: "s1", status: "active" },
  clearGoal: { sessionId: "s1" },
  listWorkspaceFileTree: { workspaceDir: "/tmp" },
  readWorkspaceFile: { workspaceDir: "/tmp", path: "a.txt" },
  getWorkspaceEnvironment: { workspaceDir: "/tmp" },
  mutateWorkspaceGit: { workspaceDir: "/tmp", action: "commit", message: "m" },
  getWorkspaceReviewSummary: { workspaceDir: "/tmp" },
  listWorkspaceReviewFileDiffs: { workspaceDir: "/tmp", reviewSnapshotId: "r1", fileIds: ["f1"] },
  getWorkspaceReviewFileContent: { workspaceDir: "/tmp", reviewSnapshotId: "r1", fileId: "f1", side: "old" },
  searchWorkspaceReviewDiffs: { workspaceDir: "/tmp", reviewSnapshotId: "r1", query: "q", includeUntrackedFiles: false },
  readCanvas: { sessionId: "s1" },
  applyCanvas: { sessionId: "s1", operation: { kind: "noop" } },
  readWorkspaceArchive: { workspaceDir: "/tmp", path: "a.zip" },
  extractWorkspaceArchive: { workspaceDir: "/tmp", path: "a.zip", destination: "/tmp/out" },
  enqueueMessage: { id: "s1", content: "hi" },
  abortSession: { id: "s1" },
  listQueueMessages: { id: "s1" },
  deleteQueueItem: { id: "s1", itemId: "i1" },
  listPendingPermissions: undefined,
  getPendingQuestionnaire: { name: "main", sessionId: "s1" },
  replyPermission: { name: "main", requestId: "r1", reply: "allowOnce" },
  replyQuestionnaire: { name: "main", requestId: "r1", schemaVersion: 1, answers: [] },
  dismissQuestionnaire: { name: "main", requestId: "r1" },
  listModels: {},
  selectModel: { providerId: "p1", modelId: "m1" },
  listSkills: {},
  pluginManagement: { action: "listApps" },
  getPermissionMode: {},
  setPermissionMode: { mode: "default" },
  getSessionUsage: { id: "s1" },
  getUsageQuota: {},
  getSigninPanel: {},
  claimSignin: {},
  getAccountStatus: {},
  beginAccountLogin: {},
  getAccountLoginStatus: {},
  cancelAccountLogin: {},
  listUserModelProviders: undefined,
  createUserModelProvider: { providerId: "p1" },
  updateUserModelProvider: { providerId: "p1" },
  deleteUserModelProvider: { providerId: "p1" },
  testUserModelProvider: { providerId: "p1" },
  testUserModel: { providerId: "p1", modelId: "m1" },
  discoverUserModelsCandidate: { providerId: "p1" },
  saveUserModelProviderCandidate: { providerId: "p1" },
  listProviderPresets: undefined,
  getMiniMaxApiKeyStatus: undefined,
  upsertMiniMaxApiKey: { apiKey: "k" },
  getCodexOAuthStatus: undefined,
  getMiniMaxModelSource: undefined,
  setMiniMaxModelSource: { source: "token_plan" },
  testUserModelCandidate: { candidate: {}, modelId: "m1" },
  revealModelProviderApiKey: { providerId: "p1" },
  startCodexOAuthLogin: {},
  cancelCodexOAuthLogin: { loginId: "l1" },
  refreshModels: undefined,
  getGlobalInstructions: {},
  setGlobalInstructions: { content: "c" },
  getAgentMemory: {},
  setAgentMemory: { content: "c" },
  getUserProfile: undefined,
  setUserProfile: { nickname: "n", occupation: "o", moreAbout: "m" },
  getMemorySettings: undefined,
  setMemorySettings: { enabled: true },
  // The 13 dedicated operations.
  browseWorkspaceDirs: { dir: EMPTY_BROWSE_DIR },
  createTerminal: { workspaceDir: "/tmp" },
  listTerminals: {},
  writeTerminal: { terminalId: "t1", data: "ls" },
  resizeTerminal: { terminalId: "t1", cols: 80, rows: 24 },
  disposeTerminal: { terminalId: "t1" },
  watchTerminal: { terminalId: "t1" },
  runCommand: { command: "status", sessionId: "s1" },
  signOut: {},
  watchEvents: undefined,
  getMessages: { id: "s1" },
  sendMessage: { id: "s1", content: "hi" },
  resumeSession: { id: "s1" },
};

/**
 * The baseline roster, read from the frozen registry — never from the
 * production binding tables. Deriving it from production would let an operation
 * added or removed today silently reshape the corpus the oracle is compared
 * against.
 */
const BASELINE_OPERATION_NAMES: readonly string[] = [
  ...createLegacyOperationRegistry(
    recordingPort().port as unknown as LegacyPort,
    recordingTerminal().terminal,
  ).keys(),
];

const TERMINAL_OPERATION_NAMES: readonly string[] = [
  "createTerminal",
  "listTerminals",
  "writeTerminal",
  "resizeTerminal",
  "disposeTerminal",
  "watchTerminal",
];

/** Optional capabilities with a declared missing policy the wire must keep. */
const OPTIONAL_CAPABILITY_OPERATIONS: Readonly<Record<string, string>> = {
  listVisibleProjects: "listVisibleProjects",
  pluginManagement: "pluginManagement",
  getPermissionMode: "getPermissionMode",
  setPermissionMode: "setPermissionMode",
  getGlobalInstructions: "getGlobalInstructions",
  setGlobalInstructions: "setGlobalInstructions",
  getAgentMemory: "getAgentMemory",
  setAgentMemory: "setAgentMemory",
  getUserProfile: "getUserProfile",
  setUserProfile: "setUserProfile",
  getMemorySettings: "getMemorySettings",
  setMemorySettings: "setMemorySettings",
  signOut: "signOutAccount",
};

describe("WebUI operation wire compatibility (baseline implementation vs typed bindings)", () => {
  it("reads the 99-operation roster from the frozen baseline registry", () => {
    expect(BASELINE_OPERATION_NAMES).toHaveLength(99);
    expect(new Set(BASELINE_OPERATION_NAMES).size).toBe(99);
    // The production split stays 86 bindings + 13 dedicated handlers, and it
    // must still name exactly the roster the baseline served.
    expect(Object.keys(WEBUI_OPERATION_BINDINGS)).toHaveLength(86);
    expect(DEDICATED_OPERATION_NAMES).toHaveLength(13);
    const productionRoster = [
      ...Object.keys(WEBUI_OPERATION_BINDINGS),
      ...DEDICATED_OPERATION_NAMES,
    ];
    expect(new Set(productionRoster).size).toBe(99);
    assert.deepEqual(
      [...productionRoster].sort(),
      [...BASELINE_OPERATION_NAMES].sort(),
    );
    for (const name of BASELINE_OPERATION_NAMES) {
      expect(
        Object.prototype.hasOwnProperty.call(VALID_BODIES, name),
        `no valid body fixture for ${name}`,
      ).toBe(true);
    }
    expect(new Set(Object.keys(VALID_BODIES))).toEqual(new Set(BASELINE_OPERATION_NAMES));
  });

  it("keeps the real baseline validators, not a hand-written approximation", async () => {
    // The exact three inputs that exposed the previous approximation: the old
    // oracle answered them with a response frame while the real baseline
    // validator (and the production one) answer `invalid_body`.
    const cases: ReadonlyArray<readonly [string, unknown]> = [
      ["version", null],
      ["archiveSession", { id: "s1", archived: "yes" }],
      ["getSession", {}],
    ];
    for (const [operation, body] of cases) {
      const baseline = await runSide("baseline", requestFrame(operation, body));
      const production = await runSide("production", requestFrame(operation, body));
      assertFrameBytesEqual(baseline.sent, production.sent, `canary ${operation}`);
      const frame = baseline.sent[0] ?? "";
      assert.ok(
        frame.includes(`"${WebuiErrorCode.invalidBody}"`),
        `${operation}: baseline oracle answered ${frame}`,
      );
    }
  });

  it("sends byte-identical frames for every operation, with identical capability calls", async () => {
    for (const name of BASELINE_OPERATION_NAMES)
      await compareFrame(name, requestFrame(name, VALID_BODIES[name]));
  });

  it("rejects the same adversarial bodies for every operation", async () => {
    const bodies: ReadonlyArray<readonly [string, unknown]> = [
      ["null", null],
      ["array", []],
      ["empty object", {}],
      ["omitted", MISSING_BODY],
      ["wrong id type", { id: 7 }],
    ];
    for (const name of BASELINE_OPERATION_NAMES) {
      for (const [label, body] of bodies) {
        await compareFrame(
          `${name} (${label})`,
          requestFrame(name, body),
        );
      }
    }
  });

  it("leaves terminal operations unregistered when no terminal manager is wired", async () => {
    for (const name of TERMINAL_OPERATION_NAMES) {
      await compareFrame(
        `${name} without a terminal manager`,
        requestFrame(name, VALID_BODIES[name]),
        { terminal: false },
      );
    }
    // A non-terminal operation is unaffected by the same absence.
    await compareFrame(
      "getSession without a terminal manager",
      requestFrame("getSession", VALID_BODIES.getSession),
      { terminal: false },
    );
  });

  it("preserves absent and non-callable optional capabilities identically", async () => {
    for (const [operation, method] of Object.entries(OPTIONAL_CAPABILITY_OPERATIONS)) {
      const body = VALID_BODIES[operation];
      await compareFrame(
        `${operation} with an absent ${method}`,
        requestFrame(operation, body),
        { plan: { override: { [method]: undefined } } },
      );
      await compareFrame(
        `${operation} with a non-callable ${method}`,
        requestFrame(operation, body),
        { plan: { override: { [method]: 42 } } },
      );
    }
  });

  it("hands each streaming capability the request signal and keeps the frames identical", async () => {
    const operations = ["watchEvents", "sendMessage", "resumeSession", "watchTerminal"] as const;
    for (const name of operations) {
      const baselineController = new AbortController();
      const productionController = new AbortController();
      const baseline = await runSide("baseline", requestFrame(name, VALID_BODIES[name]), {
        signal: baselineController.signal,
      });
      const production = await runSide("production", requestFrame(name, VALID_BODIES[name]), {
        signal: productionController.signal,
      });
      assertFrameBytesEqual(baseline.sent, production.sent, `${name} (signal)`);
      const streamCalls = baseline.calls.filter((call) =>
        /signal|watch|sendMessage|resumeSession|watchEvents/.test(call.method),
      );
      expect(streamCalls.length, `${name}: no capability call recorded`).toBeGreaterThan(0);
      for (const call of streamCalls) {
        const labels = call.args.filter((arg) => typeof arg === "string");
        expect(
          labels.includes("<injected-signal>"),
          `${name}: capability ${call.method} did not receive the request signal (${JSON.stringify(call.args)})`,
        ).toBe(true);
        expect(labels).not.toContain("<foreign-signal>");
      }
      assert.deepEqual(baseline.calls, production.calls, `${name}: capability calls diverged`);
    }
  });

  it("acknowledges the event watcher with the same response frame before any event", async () => {
    const frame = requestFrame("watchEvents", VALID_BODIES.watchEvents);
    const baseline = await runSide("baseline", frame);
    const production = await runSide("production", frame);
    assertFrameBytesEqual(baseline.sent, production.sent, "watchEvents acknowledgement");
    expect(baseline.sent).toHaveLength(1);
    assert.deepEqual(JSON.parse(baseline.sent[0] ?? ""), {
      protocolVersion: WEBUI_PROTOCOL_VERSION,
      kind: "response",
      requestId: "req-1",
      body: { stream: true },
    });
  });

  it("keeps the envelope, unknown-operation and invalid-body frames identical", async () => {
    const cases: ReadonlyArray<readonly [string, unknown]> = [
      ["unknown operation", { protocolVersion: WEBUI_PROTOCOL_VERSION, kind: "request", requestId: "req-2", operation: "notAnOperation", body: {} }],
      ["non-request frame", { protocolVersion: WEBUI_PROTOCOL_VERSION, kind: "response", requestId: "req-3", body: {} }],
      ["id-less body", { protocolVersion: WEBUI_PROTOCOL_VERSION, kind: "request", requestId: "req-4", operation: "archiveSession", body: {} }],
      ["protocol mismatch", { protocolVersion: 99, kind: "request", requestId: "req-5", operation: "archiveSession", body: {} }],
      ["terminal body dropped", { protocolVersion: WEBUI_PROTOCOL_VERSION, kind: "request", requestId: "req-6", operation: "createTerminal", body: {} }],
    ];
    for (const [label, frame] of cases) await compareFrame(label, frame);

    // The disconnecting service is an error frame too, and it is decided
    // before the registry is consulted.
    await compareFrame("shutting down", cases[2]?.[1], { accepting: false });
  });

  it("preserves a recognised error code and message from a capability", async () => {
    const baseline = await runSide(
      "baseline",
      requestFrame("getSessionDiff", VALID_BODIES.getSessionDiff),
      { plan: { override: { getSessionDiff: () => Promise.reject(rejectWith("session diff is unavailable", WebuiErrorCode.harnessError)) } } },
    );
    const production = await runSide(
      "production",
      requestFrame("getSessionDiff", VALID_BODIES.getSessionDiff),
      { plan: { override: { getSessionDiff: () => Promise.reject(rejectWith("session diff is unavailable", WebuiErrorCode.harnessError)) } } },
    );
    assertFrameBytesEqual(baseline.sent, production.sent, "recognised error");
    assert.ok((baseline.sent[0] ?? "").includes("session diff is unavailable"));
    assert.ok((baseline.sent[0] ?? "").includes(`"${WebuiErrorCode.harnessError}"`));
  });

  it("matches multiple stream frames, failures, and generator finalization counts byte-for-byte", async () => {
    const oldFinalized = { count: 0 };
    const newFinalized = { count: 0 };
    const stream = (counter: { count: number }, fail: boolean) => async function* () {
      try {
        yield { frame: 1, optional: undefined };
        yield { frame: 2, omitted: undefined };
        if (fail) throw new Error("stream failed after frame two");
      } finally {
        counter.count += 1;
      }
    };
    for (const fail of [false, true]) {
      const baseline = await runSide(
        "baseline",
        requestFrame("sendMessage", VALID_BODIES.sendMessage),
        { plan: { stream: stream(oldFinalized, fail) } },
      );
      const production = await runSide(
        "production",
        requestFrame("sendMessage", VALID_BODIES.sendMessage),
        { plan: { stream: stream(newFinalized, fail) } },
      );
      assertFrameBytesEqual(baseline.sent, production.sent, `sendMessage (fail=${fail})`);
    }
    expect(oldFinalized.count).toBe(2);
    expect(newFinalized.count).toBe(2);
  });

  it("finalizes once when the request signal closes during a pending stream", async () => {
    const runPending = async (side: Side, controller: AbortController, finalized: { count: number }) => {
      const port = pendingStreamPort(controller, finalized);
      await runSide(side, requestFrame("sendMessage", VALID_BODIES.sendMessage), {
        signal: controller.signal,
        plan: { override: { sendMessage: port } },
      });
    };
    const oldController = new AbortController();
    const newController = new AbortController();
    const oldFinalized = { count: 0 };
    const newFinalized = { count: 0 };
    const oldRun = runPending("baseline", oldController, oldFinalized);
    const newRun = runPending("production", newController, newFinalized);
    await new Promise((resolve) => setTimeout(resolve, 0));
    oldController.abort();
    newController.abort();
    await Promise.all([oldRun, newRun]);
    expect(oldFinalized.count).toBe(1);
    expect(newFinalized.count).toBe(1);
  });

  it("finalizes once when a socket-close abort arrives after the first stream frame", async () => {
    const runClose = async (side: Side) => {
      const controller = new AbortController();
      const finalized = { count: 0 };
      const run = runSide(side, requestFrame("sendMessage", VALID_BODIES.sendMessage), {
        signal: controller.signal,
        plan: { override: { sendMessage: firstFrameThenParkedPort(finalized) } },
        onSend: (payload) => {
          if (payload.includes('"kind":"event"')) controller.abort();
        },
      });
      const result = await run;
      return { sent: result.sent, finalized: finalized.count };
    };
    const baseline = await runClose("baseline");
    const production = await runClose("production");
    assertFrameBytesEqual(baseline.sent, production.sent, "socket-close abort");
    expect(baseline.finalized).toBe(1);
    expect(production.finalized).toBe(1);
  });
});

function rejectWith(message: string, code: string): Error {
  return Object.assign(new Error(message), { code });
}

/** A `sendMessage` capability whose stream parks until the signal aborts. */
function pendingStreamPort(controller: AbortController, finalizations: { count: number }) {
  return () =>
    Promise.resolve({
      ok: true,
      source: {
        [Symbol.asyncIterator]() {
          return {
            next: () =>
              new Promise<IteratorResult<unknown>>((resolve) => {
                controller.signal.addEventListener(
                  "abort",
                  () => resolve({ done: true, value: undefined }),
                  { once: true },
                );
              }),
            return: async () => {
              finalizations.count += 1;
              return { done: true, value: undefined };
            },
          };
        },
      },
    });
}

/** A `sendMessage` capability that yields one frame and then parks forever. */
function firstFrameThenParkedPort(finalizations: { count: number }) {
  return () =>
    Promise.resolve({
      ok: true,
      source: {
        [Symbol.asyncIterator]() {
          let emitted = false;
          return {
            next: () =>
              emitted
                ? new Promise<IteratorResult<unknown>>(() => {})
                : ((emitted = true), Promise.resolve({ done: false as const, value: { chunk: "first" } })),
            return: async () => {
              finalizations.count += 1;
              return { done: true, value: undefined };
            },
          };
        },
      },
    });
}
