// Protocol compatibility for every operation (stage 3, part B).
//
// The old forwarding handlers and the new registry run against *separately
// created* deterministic synthetic ports — same request ids, same generated
// values, same argument shapes — and a fake open WebSocket records the exact
// strings `send()` received. Frames are compared as UTF-8 bytes with
// `Buffer.from(a, "utf8").equals(...)`, never as parsed-and-re-sorted objects,
// because field order, omitted fields and undefined serialisation are part of
// the contract. Capability calls (port and terminal) and their arguments are
// compared too.
//
// The old handlers live in `./webui-legacy-operation-handlers.ts`: the deleted
// `server/operation/operation-handlers.ts` survives only as the "old" side of
// this comparison (plan §7.7 sanctions exactly that test-only parallelism).
// The new side is the production registry built by `operations.ts`, so all 99
// operations — the 86 bindings and the 13 dedicated handlers — are compared.
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { WebSocket } from "ws";

import { WEBUI_PROTOCOL_VERSION } from "../../src/shared/envelope.js";
import type { WebuiHarnessPort } from "../../src/runtime/port.js";
import type { WebuiTerminalManager } from "../../src/server/terminal.js";
import type {
  WebuiOperationHandler,
  WebuiOperationRegistryEntry,
} from "../../src/server/operation/operation-contract.js";
import { createOperationRegistry } from "../../src/server/index.js";
import { dispatchWebuiFrame } from "../../src/server/operation/operation-dispatch.js";
import {
  DEDICATED_OPERATION_NAMES,
  WEBUI_OPERATION_BINDINGS,
} from "../../src/server/operation/bind-handlers.js";
import { createLegacyOperationHandlers } from "./webui-legacy-operation-handlers.js";
import { runWebuiCommand } from "../../src/runtime/commands/runner.js";

/** An async iterable that yields nothing; deterministic for both sides. */
function emptyStream(): AsyncIterable<never> {
  return (async function* empty(): AsyncGenerator<never> {})();
}

interface Call {
  readonly method: string;
  readonly args: readonly unknown[];
}

/** A port whose every method records its call and returns a fixed value. */
interface RecordingPort {
  readonly port: WebuiHarnessPort;
  readonly calls: Call[];
}

function recordingPort(): RecordingPort {
  const calls: Call[] = [];
  const port = new Proxy(
    {},
    {
      get(_target, key) {
        if (typeof key !== "string") return undefined;
        if (key === "version")
          return (...args: readonly unknown[]) => {
            calls.push({ method: key, args });
            return { version: "0.0.0-fixed", protocolVersion: 1 };
          };
        // Streams return a live async iterable, not a promise. The data
        // streams wrap it through the session-stream projection; the event
        // watcher returns it directly.
        if (key === "watchEvents")
          return (...args: readonly unknown[]) => {
            calls.push({ method: key, args });
            return emptyStream();
          };
        if (key === "sendMessage" || key === "resumeSession")
          return (...args: readonly unknown[]) => {
            calls.push({ method: key, args });
            return Promise.resolve({ ok: true, source: emptyStream() });
          };
        // `runCommand` is a port capability whose implementation is the command
        // interpreter over the rest of the port. The scripted port models it the
        // same way the runtime adapter does, so both registries drive identical
        // capability calls and the comparison stays a wire comparison.
        if (key === "runCommand")
          return (request: unknown) =>
            runWebuiCommand(port as unknown as WebuiHarnessPort, request as never);
        return (...args: readonly unknown[]) => {
          calls.push({ method: key, args });
          return Promise.resolve({ method: key, args });
        };
      },
    },
  ) as unknown as WebuiHarnessPort;
  return { port, calls };
}

/** A terminal adapter whose every method records its call and returns a fixed value. */
interface RecordingTerminal {
  readonly terminal: WebuiTerminalManager;
  readonly calls: Call[];
}

function recordingTerminal(): RecordingTerminal {
  const calls: Call[] = [];
  const record = (method: string, args: readonly unknown[]) => {
    calls.push({ method, args });
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
  } as unknown as WebuiTerminalManager;
  return { terminal, calls };
}

/**
 * The "old" registry: the legacy handler map paired with the (unchanged)
 * operation descriptors. Pairing with the production descriptors isolates the
 * comparison to the handler implementations, which is exactly what changed.
 */
function legacyRegistry(
  port: WebuiHarnessPort,
  terminal: WebuiTerminalManager,
): ReadonlyMap<string, WebuiOperationRegistryEntry> {
  const descriptors = createOperationRegistry(port, terminal);
  const handlers = createLegacyOperationHandlers(port, terminal);
  const registry = new Map<string, WebuiOperationRegistryEntry>();
  for (const [name, handle] of Object.entries(handlers)) {
    const source = descriptors.get(name);
    if (!source) continue;
    registry.set(name, {
      operation: source.operation,
      handle: handle as WebuiOperationHandler<unknown>,
    });
  }
  return registry;
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

async function run(
  operations: ReadonlyMap<string, WebuiOperationRegistryEntry>,
  frame: unknown,
  socket: RecordingSocket,
): Promise<void> {
  await dispatchWebuiFrame(socket as unknown as WebSocket, frame, operations, true, () => undefined);
}

function requestFrame(operation: string, body: unknown): unknown {
  return { protocolVersion: WEBUI_PROTOCOL_VERSION, kind: "request", requestId: "req-1", operation, body };
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

/** The 99 operation names: 86 bindings plus the 13 dedicated handlers. */
const ALL_OPERATION_NAMES: readonly string[] = [
  ...Object.keys(WEBUI_OPERATION_BINDINGS),
  ...DEDICATED_OPERATION_NAMES,
];

async function compareOperation(name: string): Promise<void> {
  const oldPort = recordingPort();
  const newPort = recordingPort();
  const oldTerminal = recordingTerminal();
  const newTerminal = recordingTerminal();
  const oldRegistry = legacyRegistry(oldPort.port, oldTerminal.terminal);
  const newRegistry = createOperationRegistry(newPort.port, newTerminal.terminal);
  const frame = requestFrame(name, VALID_BODIES[name]);

  const oldSocket = recordingSocket();
  const newSocket = recordingSocket();
  await run(oldRegistry, frame, oldSocket);
  await run(newRegistry, frame, newSocket);

  assert.equal(
    oldSocket.sent.length,
    newSocket.sent.length,
    `${name}: frame count diverged (old ${oldSocket.sent.length}, new ${newSocket.sent.length})`,
  );
  for (let index = 0; index < oldSocket.sent.length; index += 1) {
    const oldFrame = oldSocket.sent[index] ?? "";
    const newFrame = newSocket.sent[index] ?? "";
    assert.ok(
      Buffer.from(oldFrame, "utf8").equals(Buffer.from(newFrame, "utf8")),
      `${name}: frame ${index} diverged\nold: ${oldFrame}\nnew: ${newFrame}`,
    );
  }
  assert.deepEqual(
    [...oldPort.calls, ...oldTerminal.calls],
    [...newPort.calls, ...newTerminal.calls],
    `${name}: capability calls diverged`,
  );
}

describe("WebUI operation wire compatibility (old handlers vs typed bindings)", () => {
  it("covers all 99 operations exactly once (86 bindings + 13 dedicated handlers)", () => {
    expect(Object.keys(WEBUI_OPERATION_BINDINGS)).toHaveLength(86);
    expect(DEDICATED_OPERATION_NAMES).toHaveLength(13);
    expect(ALL_OPERATION_NAMES).toHaveLength(99);
    expect(new Set(ALL_OPERATION_NAMES).size).toBe(99);
  });

  it("sends byte-identical frames for every operation, with identical capability calls", async () => {
    for (const name of ALL_OPERATION_NAMES) await compareOperation(name);
  });

  it("compares the 13 dedicated operations old-vs-new", async () => {
    expect(DEDICATED_OPERATION_NAMES).toHaveLength(13);
    for (const name of DEDICATED_OPERATION_NAMES) await compareOperation(name);
  });

  it("keeps the envelope, unknown-operation and invalid-body frames identical", async () => {
    const oldRegistry = legacyRegistry(recordingPort().port, recordingTerminal().terminal);
    const newRegistry = createOperationRegistry(recordingPort().port, recordingTerminal().terminal);

    const cases: ReadonlyArray<unknown> = [
      { protocolVersion: WEBUI_PROTOCOL_VERSION, kind: "request", requestId: "req-2", operation: "notAnOperation", body: {} },
      { protocolVersion: WEBUI_PROTOCOL_VERSION, kind: "response", requestId: "req-3", body: {} },
      { protocolVersion: WEBUI_PROTOCOL_VERSION, kind: "request", requestId: "req-4", operation: "archiveSession", body: {} },
      { protocolVersion: 99, kind: "request", requestId: "req-5", operation: "archiveSession", body: {} },
      { protocolVersion: WEBUI_PROTOCOL_VERSION, kind: "request", requestId: "req-6", operation: "createTerminal", body: {} },
    ];

    for (const frame of cases) {
      const oldSocket = recordingSocket();
      const newSocket = recordingSocket();
      await run(oldRegistry, frame, oldSocket);
      await run(newRegistry, frame, newSocket);
      assert.equal(oldSocket.sent.length, newSocket.sent.length);
      assert.ok(Buffer.from(oldSocket.sent[0] ?? "", "utf8").equals(Buffer.from(newSocket.sent[0] ?? "", "utf8")));
    }
  });

  it("preserves a recognised error code and message from a capability", async () => {
    const failure = Object.assign(new Error("session diff is unavailable"), {
      code: "harness_error",
    });
    const makePort = (): WebuiHarnessPort =>
      new Proxy({}, {
        get(_t, key) {
          if (typeof key !== "string") return undefined;
          if (key === "getSessionDiff") return () => Promise.reject(failure);
          if (key === "watchEvents") return () => emptyStream();
          if (key === "sendMessage" || key === "resumeSession")
            return () => Promise.resolve({ ok: true, source: emptyStream() });
          return () => Promise.resolve({});
        },
      }) as unknown as WebuiHarnessPort;

    const frame = requestFrame("getSessionDiff", { id: "s1" });
    const oldSocket = recordingSocket();
    const newSocket = recordingSocket();
    await run(legacyRegistry(makePort(), recordingTerminal().terminal), frame, oldSocket);
    await run(createOperationRegistry(makePort(), recordingTerminal().terminal), frame, newSocket);
    assert.ok(Buffer.from(oldSocket.sent[0] ?? "", "utf8").equals(Buffer.from(newSocket.sent[0] ?? "", "utf8")));
    assert.ok((oldSocket.sent[0] ?? "").includes("session diff is unavailable"));
  });
});
