// Protocol compatibility for the 86 typed bindings (stage 3, part B).
//
// The old forwarding handlers and the new typed bindings run against
// *separately created* deterministic synthetic ports — same request ids, same
// generated values, same argument shapes — and a fake open WebSocket records
// the exact strings `send()` received. Frames are compared as UTF-8 bytes with
// `Buffer.from(a, "utf8").equals(...)`, never as parsed-and-re-sorted objects,
// because field order, omitted fields and undefined serialisation are part of
// the contract. Capability calls and their arguments are compared too.
//
// The 13 operations that keep dedicated handlers are covered by the matched
// dispatcher here as far as the dispatcher itself is concerned; the exhaustive
// old/new comparison for those is not part of this delivery.
import assert from "node:assert/strict";
import { describe, expect, it } from "vitest";
import type { WebSocket } from "ws";

import { WEBUI_PROTOCOL_VERSION } from "../../src/shared/envelope.js";
import type { WebuiHarnessPort } from "../../src/runtime/port.js";
import type { WebuiOperationRegistryEntry } from "../../src/server/operation/operation-contract.js";
import { createOperationRegistry } from "../../src/server/index.js";
import { dispatchWebuiFrame } from "../../src/server/operation/operation-dispatch.js";
import {
  WEBUI_OPERATION_BINDINGS,
  createBindingEntries,
} from "../../src/server/operation/bind-handlers.js";

/** A port whose every method records its call and returns a fixed value. */
interface RecordingPort {
  readonly port: WebuiHarnessPort;
  readonly calls: Array<{ readonly method: string; readonly args: readonly unknown[] }>;
}

function recordingPort(): RecordingPort {
  const calls: Array<{ readonly method: string; readonly args: readonly unknown[] }> = [];
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
        return (...args: readonly unknown[]) => {
          calls.push({ method: key, args });
          return Promise.resolve({ method: key, args });
        };
      },
    },
  ) as unknown as WebuiHarnessPort;
  return { port, calls };
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

/** One valid request body per binding, so the handler (not the validator) runs. */
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
};

describe("WebUI operation wire compatibility (old handlers vs typed bindings)", () => {
  it("sends byte-identical frames for every binding, with identical capability calls", async () => {
    const names = Object.keys(WEBUI_OPERATION_BINDINGS);
    expect(names).toHaveLength(86);

    for (const name of names) {
      const oldPort = recordingPort();
      const newPort = recordingPort();
      const oldRegistry = createOperationRegistry(oldPort.port);
      const newRegistry = createBindingEntries(newPort.port);
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
      assert.deepEqual(newPort.calls, oldPort.calls, `${name}: capability calls diverged`);
      assert.ok(oldPort.calls.length > 0, `${name}: neither side called a capability`);
    }
  });

  it("keeps the envelope, unknown-operation and invalid-body frames identical", async () => {
    const oldRegistry = createOperationRegistry(recordingPort().port);
    const newRegistry = createBindingEntries(recordingPort().port);

    const cases: ReadonlyArray<unknown> = [
      { protocolVersion: WEBUI_PROTOCOL_VERSION, kind: "request", requestId: "req-2", operation: "notAnOperation", body: {} },
      { protocolVersion: WEBUI_PROTOCOL_VERSION, kind: "response", requestId: "req-3", body: {} },
      { protocolVersion: WEBUI_PROTOCOL_VERSION, kind: "request", requestId: "req-4", operation: "archiveSession", body: {} },
      { protocolVersion: 99, kind: "request", requestId: "req-5", operation: "archiveSession", body: {} },
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
          return () => Promise.resolve({});
        },
      }) as unknown as WebuiHarnessPort;

    const frame = requestFrame("getSessionDiff", { id: "s1" });
    const oldSocket = recordingSocket();
    const newSocket = recordingSocket();
    await run(createOperationRegistry(makePort()), frame, oldSocket);
    await run(createBindingEntries(makePort()), frame, newSocket);
    assert.ok(Buffer.from(oldSocket.sent[0] ?? "", "utf8").equals(Buffer.from(newSocket.sent[0] ?? "", "utf8")));
    assert.ok((oldSocket.sent[0] ?? "").includes("session diff is unavailable"));
  });
});
