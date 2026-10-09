// Service tests for the WebUI loopback service and runtime seam.
//
// The brief calls for TDD at the service seam: construct the real
// `WebuiService` with a scripted stand-in for the harness port, connect a
// real WebSocket client, and assert the frames. Each acceptance criterion
// has its own fixture; the same scripted port keeps the harness-side
// surface honest (the harness never runs against real history, per ADR
// 0006) while the wire side exercises the real `ws` package.

import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import assert from "node:assert/strict";
import { once } from "node:events";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RawData } from "ws";
import { WebSocket } from "ws";

import { updateLocalModelSelection } from "@mavis/config";
import {
  resetDefaultLocalRuntimeConfig,
} from "@mavis/local-runtime-v2";

import {
  WebuiErrorCode,
  WEBUI_PROTOCOL_VERSION,
  WebuiService,
  isWebuiFrame,
  type WebuiCreateSessionResult,
  type WebuiEnqueueMessageRequest,
  type WebuiHarnessPort,
  type WebuiMessagesRequest,
  type WebuiMessagesResult,
  type WebuiCreateSessionRequest,
  type WebuiSessionLookupRequest,
  type WebuiActiveTurnResult,
  type WebuiSessionLookupResult,
  type WebuiSessionListRequest,
  type WebuiSessionListItem,
  type WebuiSessionPage,
  type WebuiSessionTreePage,
  type WebuiSessionTreeRequest,
  type WebuiVersionInfo,
  type WebuiSendMessageRequest,
  type WebuiSendMessageResult,
  type WebuiResumeSessionRequest,
  type WebuiStreamResult,
  type WebuiRuntimeEvent,
  type WebuiPermissionDecision,
  type WebuiGetSessionDiffRequest,
  type WebuiGetTurnDiffRequest,
  type WebuiErrorFrame,
} from "../../src/server/index.js";
import type {
  WebuiGetSessionRewindPreviewRequest,
  WebuiGetSessionRewindPreviewResult,
  WebuiRewindSessionRequest,
  WebuiRewindSessionResult,
  WebuiEditSessionMessageRequest,
  WebuiEditSessionMessageResult,
  WebuiImportSessionTransferRequest,
  WebuiImportSessionTransferResult,
  WebuiSessionTransferFile,
} from "../../src/shared/contracts/session.js";
import type {
  WebuiGoal,
  WebuiGoalCreateRequest,
  WebuiGoalPatchRequest,
} from "../../src/shared/contracts/goal.js";
import { createWebuiTransport } from "../../src/client/transport.js";
import { WebuiTerminalManager } from "../../src/server/terminal.js";
import { getWorkspaceReviewSummaryOperation, listWorkspaceReviewFileDiffsOperation, getWorkspaceReviewFileContentOperation, searchWorkspaceReviewDiffsOperation } from "../../src/server/operation/workspace.js";

type CloseEvent = [number, Buffer];
// `once` from `node:events` is overloaded and not generic, so
// `ReturnType<typeof onceFn<T>>` does not type-check; the concrete
// return shape is `Promise<unknown[]>` (the args tuple), which is
// all the assertions in this file actually need.
type OncePromise<T> = Promise<T[]>;

/**
 * The staged tree the `/workspace-file` tests point `dir` at, plus the bound
 * loopback endpoint serving it. See `bootWorkspaceTree` for why the tree
 * carries a prefix-sharing sibling.
 */
interface WorkspaceFileTree {
  readonly endpoint: string;
  readonly token: string;
  readonly root: string;
  readonly sibling: string;
  readonly outside: string;
}

class ScriptedHarnessPort implements WebuiHarnessPort {
  lastProviderTest?: { readonly providerId: string; readonly apiKey?: string };
  lastModelTest?: { readonly providerId: string; readonly modelId: string };
  providerMutations: Array<{ readonly operation: string; readonly request: unknown }> = [];
  private versionInfo: WebuiVersionInfo = {
    version: "0.1.0-test",
    protocolVersion: WEBUI_PROTOCOL_VERSION,
  };
  public closed = false;
  public sendResult: WebuiSendMessageResult = {
    ok: true,
    source: [{ dataJson: '{"type":10}' }, { dataJson: "[DONE]" }],
  };
  public resumeResult: WebuiStreamResult = {
    ok: true,
    source: [{ dataJson: '{"type":10}' }, { dataJson: "[DONE]" }],
  };
  public lastResumeRequest: WebuiResumeSessionRequest | undefined;
  public lastEnqueueRequest: WebuiEnqueueMessageRequest | undefined;
  public lastPermissionReply: unknown;
  public lastQuestionnaireReply: unknown;
  public lastQuestionnaireDismissal: unknown;
  public abortCalls = 0;
  public diffRequests: Array<{ readonly operation: string; readonly body: unknown }> = [];
  public reviewRequests: Array<{ readonly operation: string; readonly body: unknown }> = [];
  public reviewError: Error | undefined;
  public sendObserved: Promise<void>;
  private resolveSendObserved!: () => void;

  constructor() {
    this.sendObserved = new Promise<void>((resolve) => {
      this.resolveSendObserved = resolve;
    });
  }

  recordLog(version: string) {
    this.versionInfo = {
      version,
      protocolVersion: WEBUI_PROTOCOL_VERSION,
    };
  }

  version(): WebuiVersionInfo {
    return this.versionInfo;
  }

  async listSessions(request: WebuiSessionListRequest): Promise<WebuiSessionPage> {
    if (request.onlyArchived) {
      const sessions: WebuiSessionListItem[] = [{
        sessionId: "archived-fixture",
        agentName: "main",
        createdAt: 1,
        updatedAt: 2,
        archived: true,
        title: "Archived fixture",
      }];
      return { sessions, hasMore: false };
    }
    return { sessions: [], hasMore: false };
  }

  async getSessionTree(_request: WebuiSessionTreeRequest): Promise<WebuiSessionTreePage> {
    return { sessions: [], hasMore: false };
  }

  async archiveSession() { return { success: true }; }
  async deleteSession() { return { success: true }; }
  async updateSession() { return { session: { sessionId: "fixture-session", title: "Renamed fixture" } }; }
  async getSessionForkOptions() { return { canFork: true, worktreeVisible: true, worktreeEligible: true }; }
  async forkSession() { return { session: { sessionId: "forked-fixture" } }; }

  async createSession(_request: WebuiCreateSessionRequest): Promise<WebuiCreateSessionResult> {
    return { sessionId: "created-session" };
  }

  async getSession(_request: WebuiSessionLookupRequest): Promise<WebuiSessionLookupResult> {
    return { session: { sessionId: "fixture-session" } };
  }

  async getActiveTurn(): Promise<WebuiActiveTurnResult> {
    return undefined;
  }

  async getMessages(
    _request: WebuiMessagesRequest,
  ): Promise<WebuiMessagesResult> {
    return { messages: [], hasMore: false };
  }

  // The transfer round trip has its own tests. These two exist because
  // `WebuiHarnessPort` requires them, and they throw rather than return a
  // plausible empty value: a double that answers a call it was never taught
  // to answer turns a missing assertion into a passing one.
  async exportSessionTransfer(
    _request: { readonly id: string },
  ): Promise<WebuiSessionTransferFile> {
    throw new Error("exportSessionTransfer is not scripted on this double");
  }

  async importSessionTransfer(
    _request: WebuiImportSessionTransferRequest,
  ): Promise<WebuiImportSessionTransferResult> {
    throw new Error("importSessionTransfer is not scripted on this double");
  }

  async getSessionDiff(request: WebuiGetSessionDiffRequest) {
    this.diffRequests.push({ operation: "getSessionDiff", body: request });
    return { diffs: [{ file: "session.ts", additions: 1, deletions: 0 }], changeSetId: "changes-1" };
  }

  async getTurnDiff(request: WebuiGetTurnDiffRequest) {
    this.diffRequests.push({ operation: "getTurnDiff", body: request });
    return { status: "active", canUndo: true, canReapply: false, changeSetId: "changes-1", fileChanges: [{ file: "turn.ts", additions: 2, deletions: 1 }] };
  }

  async revertTurnDiff(request: WebuiGetTurnDiffRequest) {
    this.diffRequests.push({ operation: "revertTurnDiff", body: request });
    return { success: true, turnDiff: { status: "reverted", canUndo: false, canReapply: true, changeSetId: "changes-1", fileChanges: [{ file: "turn.ts", additions: 2, deletions: 1 }] } };
  }

  async reapplyTurnDiff(request: WebuiGetTurnDiffRequest) {
    this.diffRequests.push({ operation: "reapplyTurnDiff", body: request });
    return { success: true, status: "active", canUndo: true, canReapply: false, changeSetId: "changes-1", fileChanges: [{ file: "turn.ts", additions: 2, deletions: 1 }] };
  }

  async getSessionRewindPreview(_request: WebuiGetSessionRewindPreviewRequest): Promise<WebuiGetSessionRewindPreviewResult> {
    return { turns: [] };
  }

  async rewindSession(_request: WebuiRewindSessionRequest): Promise<WebuiRewindSessionResult> {
    return { rewound: false };
  }

  async editSessionMessage(_request: WebuiEditSessionMessageRequest): Promise<WebuiEditSessionMessageResult> {
    return { rewound: false };
  }

  async isGoalEnabled() {
    return { enabled: true };
  }

  async getGoal(): Promise<WebuiGoal | undefined> {
    return undefined;
  }

  async createGoal(request: WebuiGoalCreateRequest): Promise<WebuiGoal> {
    return {
      goalId: "goal-fixture",
      sessionId: request.sessionId,
      objective: request.objective,
      status: "active",
      createdAt: 0,
      updatedAt: 0,
      tokensUsed: 0,
      turnsUsed: 0,
      timeUsedSeconds: 0,
      tokenBudget: request.tokenBudget ?? null,
      statusReason: null,
    };
  }

  async patchGoal(request: WebuiGoalPatchRequest): Promise<WebuiGoal> {
    return {
      goalId: "goal-fixture",
      sessionId: request.sessionId,
      objective: request.objective ?? "",
      status: request.status ?? "active",
      createdAt: 0,
      updatedAt: 0,
      tokensUsed: 0,
      turnsUsed: 0,
      timeUsedSeconds: 0,
      tokenBudget: request.tokenBudget ?? null,
      statusReason: null,
    };
  }

  async clearGoal() {
    return { success: true };
  }

  async invalidateAuth(): Promise<void> {
    // Test fixture: nothing to invalidate.
  }

  async listWorkspaceFileTree() {
    return [{ path: "README.md", name: "README.md", kind: "file" }];
  }

  // The archive operations joined `WebuiHarnessPort` with the F-zone
  // contract. This fixture has no archive to serve, so it answers with an
  // empty listing rather than going unimplemented — the port type requires
  // the member, and an absent method would be a runtime `TypeError` instead.
  async readWorkspaceArchive() {
    return { archivePath: "", entries: [], totalEntries: 0, truncated: false };
  }

  async extractWorkspaceArchive() {
    return { archivePath: "", destination: "", writtenFiles: 0 };
  }

  async getWorkspaceEnvironment() {
    return { isGitRepo: true, branch: "fixture", changedFiles: 1, insertions: 2, deletions: 1, lineStatsStatus: "ready" as const, canPush: true };
  }

  async mutateWorkspaceGit() {
    return { success: true };
  }
  async getWorkspaceReviewSummary(request: { readonly workspaceDir: string }) {
    this.reviewRequests.push({ operation: "getWorkspaceReviewSummary", body: request });
    if (this.reviewError) throw this.reviewError;
    return { repositoryId: "fixture-repo", reviewSnapshotId: "fixture-snapshot", files: [{ fileId: "file-1", path: "src/index.ts", status: "modified" as const, additions: 1, deletions: 0 }], totals: { files: 1, additions: 1, deletions: 0 } };
  }
  async listWorkspaceReviewFileDiffs(request: { readonly workspaceDir: string; readonly reviewSnapshotId: string; readonly fileIds: readonly string[] }) {
    this.reviewRequests.push({ operation: "listWorkspaceReviewFileDiffs", body: request });
    if (this.reviewError) throw this.reviewError;
    return { reviewSnapshotId: request.reviewSnapshotId, diffs: [] };
  }
  async getWorkspaceReviewFileContent(request: { readonly workspaceDir: string; readonly reviewSnapshotId: string; readonly fileId: string; readonly side: "old" | "new" }) {
    this.reviewRequests.push({ operation: "getWorkspaceReviewFileContent", body: request });
    if (this.reviewError) throw this.reviewError;
    return { reviewSnapshotId: request.reviewSnapshotId, fileId: request.fileId, path: "src/index.ts", side: request.side, type: "text" as const, content: "fixture source" };
  }
  async searchWorkspaceReviewDiffs(request: { readonly workspaceDir: string; readonly reviewSnapshotId: string; readonly query: string; readonly includeUntrackedFiles: boolean; readonly pageIndex?: number; readonly pageSize?: number }) {
    this.reviewRequests.push({ operation: "searchWorkspaceReviewDiffs", body: request });
    if (this.reviewError) throw this.reviewError;
    return { reviewSnapshotId: request.reviewSnapshotId, matchedFiles: [{ fileId: "file-1", path: "src/index.ts", matchCount: 1 }], totalMatches: 1, totalMatchedFiles: 1, pageIndex: request.pageIndex ?? 0, pageSize: request.pageSize ?? 20, matchesBeforePage: 0, hasPreviousPage: false, hasNextPage: false };
  }

  async readWorkspaceFile(request: { readonly workspaceDir: string; readonly path: string }) {
    if (request.path.includes("..")) throw new Error("Path traversal denied");
    return { type: "text" as const, content: "fixture content\n" };
  }

  async readCanvas() {
    return { schemaVersion: 1, canvasId: "canvas-fixture", sessionId: "fixture-session", changeSeq: 0, nodes: [], updatedAtMs: 0 };
  }

  async applyCanvas(request: { readonly sessionId: string; readonly operation: Record<string, unknown> }) {
    return { operationId: String(request.operation.operationId ?? "fixture-operation"), document: await this.readCanvas() };
  }

  async sendMessage(
    _request: WebuiSendMessageRequest,
  ): Promise<WebuiSendMessageResult> {
    this.resolveSendObserved();
    return this.sendResult;
  }

  async enqueueMessage(request: WebuiEnqueueMessageRequest) {
    this.lastEnqueueRequest = request;
    return { itemId: "queued-fixture", status: "queued", position: 1 };
  }

  async resumeSession(
    request: WebuiResumeSessionRequest,
  ): Promise<WebuiStreamResult> {
    this.lastResumeRequest = request;
    return this.resumeResult;
  }

  async *watchEvents(signal?: AbortSignal): AsyncIterable<WebuiRuntimeEvent> {
    yield {
      type: "session.start",
      payload: { sessionId: "fixture-session", agentName: "main" },
      timestamp: Date.now(),
      source: "test",
    };
    await new Promise<void>((resolve) => {
      if (signal?.aborted) {
        resolve();
        return;
      }
      signal?.addEventListener("abort", () => resolve(), { once: true });
    });
  }

  async listPendingPermissions() {
    return { requests: [] };
  }

  async getPendingQuestionnaire() {
    return {};
  }

  async replyPermission(request: {
    readonly name: string;
    readonly requestId: string;
    readonly reply: WebuiPermissionDecision;
  }) {
    this.lastPermissionReply = request;
    return { success: true };
  }

  async replyQuestionnaire(request: Record<string, unknown>) {
    this.lastQuestionnaireReply = request;
    return { ok: true };
  }

  async dismissQuestionnaire(request: Record<string, unknown>) {
    this.lastQuestionnaireDismissal = request;
    return { ok: true };
  }

  async abortSession() {
    this.abortCalls += 1;
    return { success: true };
  }

  async listQueueMessages() {
    return { items: [], paused: false, pendingCount: 0 };
  }

  async deleteQueueItem() {
    return {};
  }

  async listModels() {
    return [];
  }

  async listSkills() {
    return { skills: [] };
  }

  async selectModel() {
    return { success: true };
  }

  async getSessionUsage() {
    return {};
  }

  async getUsageQuota() {
    return { signedIn: false as const };
  }

  async getSigninPanel() {
    return { scene: 0, days: [] };
  }

  async claimSignin() {
    return {
      claim_id: "stub",
      claim_result: 2,
      day_no: 1,
      points: 0,
      expire_at_ms: 0,
      panel: { scene: 0, days: [] },
    };
  }

  // Added with the N-zone account login contract.
  async beginAccountLogin() {
    return { state: "idle" as const };
  }

  async getAccountLoginStatus() {
    return { state: "idle" as const };
  }

  async cancelAccountLogin() {
    return { ok: true as const };
  }

  async signOutAccount() {
    return { status: "anonymous", generation: 0 };
  }

  async getAccountStatus() {
    return { available: true };
  }

  async listUserModelProviders() { return [{ providerId: "fixture-provider", name: "Fixture" }]; }
  async createUserModelProvider(request: Record<string, unknown>) { this.providerMutations.push({ operation: "create", request }); return { success: true, providerId: request.providerId }; }
  async updateUserModelProvider(request: Record<string, unknown>) { this.providerMutations.push({ operation: "update", request }); return { success: true }; }
  async deleteUserModelProvider(providerId: string) { this.providerMutations.push({ operation: "delete", request: providerId }); return { success: true }; }
  async testUserModelProvider(request: { readonly providerId: string; readonly apiKey?: string }) { this.lastProviderTest = request; return { success: true, status: { state: "ok" } }; }
  async testUserModel(request: { readonly providerId: string; readonly modelId: string }) { this.lastModelTest = request; return { success: true, status: { state: "ok" } }; }
  async discoverUserModelsCandidate(request: Record<string, unknown>) { this.providerMutations.push({ operation: "discover", request }); return [{ modelId: "discovered-model" }]; }
  async saveUserModelProviderCandidate(request: Record<string, unknown>) { this.providerMutations.push({ operation: "save-candidate", request }); return { success: true }; }
  async listProviderPresets() { return []; }
  async getMiniMaxApiKeyStatus() { return { hasApiKey: false }; }
  async upsertMiniMaxApiKey() { return { success: true }; }
  async getCodexOAuthStatus() { return { connected: false }; }
  async getMiniMaxModelSource() { return "token_plan" as const; }
  async setMiniMaxModelSource(request: { source: "token_plan" | "minimax_api_key" }) { return request.source; }
  async testUserModelCandidate(request: { readonly candidate: Record<string, unknown>; readonly modelId: string }) { this.providerMutations.push({ operation: "test-candidate", request }); return { success: true }; }
  async revealModelProviderApiKey() { return ""; }
  async startCodexOAuthLogin() { return { loginId: "fixture" }; }
  async cancelCodexOAuthLogin() { return { connected: false }; }
  async refreshModels() { return { models: [] }; }
  async requestCompaction() { return { success: true }; }

  async close(): Promise<void> {
    this.closed = true;
  }
}

class ClosingSocket {
  private readonly listeners = new Map<
    "open" | "message" | "error" | "close",
    Array<(event: { data?: unknown }) => void>
  >();
  private closed = false;

  constructor(_url: string) {
    queueMicrotask(() => this.emit("open", {}));
  }

  addEventListener(
    type: "open" | "message" | "error" | "close",
    listener: (event: { data?: unknown }) => void,
  ): void {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  send(_data: string): void {
    this.close();
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.emit("close", {});
  }

  private emit(
    type: "open" | "message" | "error" | "close",
    event: { data?: unknown },
  ): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

class SilentOpenSocket {
  private readonly listeners = new Map<
    "open" | "message" | "error" | "close",
    Array<(event: { data?: unknown }) => void>
  >();

  constructor(_url: string) {
    queueMicrotask(() => this.emit("open", {}));
  }

  addEventListener(
    type: "open" | "message" | "error" | "close",
    listener: (event: { data?: unknown }) => void,
  ): void {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  // Answers `watchEvents` the way the server does — one `response` frame
  // carrying the request's id — because the transport treats that
  // acknowledgement, not the socket opening, as "the watcher is live". A
  // stub that stays silent would make every readiness decision untestable.
  send(data: string): void {
    let request: { requestId?: unknown; operation?: unknown };
    try {
      request = JSON.parse(data) as { requestId?: unknown; operation?: unknown };
    } catch {
      return;
    }
    if (request.operation !== "watchEvents") return;
    if (typeof request.requestId !== "string") return;
    queueMicrotask(() =>
      this.emit("message", {
        data: JSON.stringify({
          kind: "response",
          requestId: request.requestId,
          body: { ok: true },
        }),
      }),
    );
  }

  close(): void {}

  private emit(
    type: "open" | "message" | "error" | "close",
    event: { data?: unknown },
  ): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

// Build a WebSocket client and capture every observable lifecycle event
// synchronously, so a test that observes a refusal can never lose the
// close race against the error-and-close pair the `ws` library emits
// back to back for a refused handshake.
//
// The `ws` library surfaces an upgrade refusal both as an `error`
// event and as the rejection of any `events.once(ws, "open")` listener;
// both fire from the same `process.nextTick`. `error` is attached
// unconditionally so the EventEmitter contract does not throw, but
// `once(ws, "error")` is *not* taken: the rejection arrives via the
// upgrade promise so callers can branch on its message. `close` is
// taken up-front because the library emits it on the same tick as
// `error`; attaching it after the rejection has already landed loses
// the event and the test hangs.
function openClient(
  url: string,
  headers: Record<string, string> = {},
): {
  ws: WebSocket;
  upgrade: OncePromise<unknown>;
  closed: Promise<{ code: number; reason: string }>;
} {
  const ws = new WebSocket(url, { headers });
  ws.on("error", () => undefined);
  const upgrade = once(ws, "open"); // rejects with the refusal; must be awaited
  const closed = new Promise<{ code: number; reason: string }>((resolve) => {
    ws.once("close", (code, reason) =>
      resolve({ code, reason: reason.toString("utf8") }),
    );
  });
  return { ws, upgrade, closed };
}

function requestOnce(ws: WebSocket, request: unknown): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const onMessage = (raw: RawData) => {
      ws.off("message", onMessage);
      ws.off("error", onError);
      try {
        resolve(JSON.parse(raw.toString("utf8")));
      } catch (error) {
        reject(error);
      }
    };
    const onError = (error: Error) => {
      ws.off("message", onMessage);
      reject(error);
    };
    ws.on("message", onMessage);
    ws.once("error", onError);
    ws.send(JSON.stringify(request));
  });
}

function awaitClose(ws: WebSocket): Promise<{ code: number; reason: string }> {
  return new Promise((resolve) => {
    ws.once("close", (code, reason) => {
      resolve({ code, reason: reason.toString("utf8") });
    });
  });
}

// Finalising an in-flight stream is driven by the *server* half of the closing
// handshake: `WebuiService` runs `connectionController.abort()` from its own
// `ws.on("close")` handler (src/server/service.ts:502-506), and that abort is
// what calls `iterator.return()` via the listener at
// src/server/operation/operation-dispatch.ts:96-97. The client-side `close`
// event these tests await is a *different socket's* event, and the `ws` library
// gives no ordering guarantee between the two — measured here, the server's
// close handler lands one loop turn after the client's in roughly half of
// full-file runs. So a fixed number of ticks after `await closed` is a guess,
// not a barrier: the single `setImmediate` this replaced passed in 2 of 5 runs
// and failed in 3. This waits for the condition itself, bounded, so a real
// regression fails with a readable message instead of hanging or passing by
// luck.
const FINALISATION_TIMEOUT_MS = 2_000;

function awaitFinalised(
  finalised: Promise<unknown>,
  what: string,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(
        new Error(
          `timed out after ${FINALISATION_TIMEOUT_MS}ms waiting for ${what}`,
        ),
      );
    }, FINALISATION_TIMEOUT_MS);
    finalised.then(
      () => {
        clearTimeout(timer);
        resolve();
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

describe("WebUI service", () => {
  it("turns a node-pty native load failure into an actionable error", () => {
    const manager = new WebuiTerminalManager(() => { throw new Error("Failed to load native module: pty.node"); });
    expect(() => manager.create("/tmp")).toThrow(/node-gyp rebuild/);
  });
  let port: ScriptedHarnessPort;
  let service: WebuiService;

  beforeEach(() => {
    port = new ScriptedHarnessPort();
  });

  afterEach(async () => {
    if (service) {
      try {
        await service.close();
      } catch {
        // close after a refused upgrade may already have torn down the listener.
      }
    }
  });

  async function bootService(): Promise<{
    url: string;
    credential: { token: string };
  }> {
    service = new WebuiService({ port });
    const info = await service.start();
    expect(info.host).toBe("127.0.0.1");
    expect(info.tcpPort).toBeGreaterThan(0);
    expect(info.protocolVersion).toBe(WEBUI_PROTOCOL_VERSION);
    expect(typeof info.credential.token).toBe("string");
    return {
      url: `${info.boundUrl}/?token=${encodeURIComponent(info.credential.token)}`,
      credential: info.credential,
    };
  }

  // Awaits the upgrade promise and asserts the rejection carries the
  // expected guard. The promise is consumed on every refusal path, so the
  // `ws` library's refused-handshake rejection never escapes as an
  // unhandled event. The regex is matched against the rejection's
  // `message`, which the `ws` library populates from the HTTP status
  // line of the refused response (`Unexpected server response: 401`,
  // `... : 403`, etc.).
  async function assertRefusal(
    upgrade: OncePromise<unknown>,
    pattern: RegExp,
  ): Promise<void> {
    try {
      await upgrade;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!pattern.test(message)) {
        throw new Error(
          `expected upgrade to refuse with ${pattern}; got: ${message}`,
        );
      }
      return;
    }
    throw new Error(`expected upgrade to refuse with ${pattern}; it resolved`);
  }

  it("refuses connections missing the per-start credential", async () => {
    await bootService();
    const info = service.info();
    const url = `ws://127.0.0.1:${info.tcpPort}`;
    const { ws, upgrade, closed } = openClient(url);
    await assertRefusal(upgrade, /401/);
    expect((await closed).code).not.toBe(1000);
  });

  it("refuses connections that present a wrong credential", async () => {
    await bootService();
    const info = service.info();
    const url = `ws://127.0.0.1:${info.tcpPort}/?token=definitely-not-it`;
    const { ws, upgrade, closed } = openClient(url);
    await assertRefusal(upgrade, /401/);
    expect((await closed).code).not.toBe(1000);
  });

  it("refuses connections with a non-loopback Host header", async () => {
    await bootService();
    const info = service.info();
    const url = `ws://127.0.0.1:${info.tcpPort}/?token=${info.credential.token}`;
    const { ws, upgrade, closed } = openClient(url, {
      Host: "evil.example:80",
    });
    await assertRefusal(upgrade, /403/);
    expect((await closed).code).not.toBe(1000);
  });

  it("refuses connections with a non-loopback Origin header", async () => {
    await bootService();
    const info = service.info();
    const url = `ws://127.0.0.1:${info.tcpPort}/?token=${info.credential.token}`;
    const { ws, upgrade, closed } = openClient(url, {
      Origin: "https://evil.example",
    });
    await assertRefusal(upgrade, /403/);
    expect((await closed).code).not.toBe(1000);
  });

  it("answers a version query over the wire with the harness-reported version", async () => {
    port.recordLog("0.3.1-fixture");
    const { url } = await bootService();
    const { ws, upgrade } = openClient(url);
    await upgrade;
    const request = {
      protocolVersion: WEBUI_PROTOCOL_VERSION,
      kind: "request",
      requestId: "req-version-1",
      operation: "version",
      body: undefined,
    };
    const response = await requestOnce(ws, request);
    expect(isWebuiFrame(response)).toBe(true);
    if (!isWebuiFrame(response)) return;
    expect(response.kind).toBe("response");
    if (response.kind !== "response") throw new Error("expected response frame");
    expect(response.protocolVersion).toBe(WEBUI_PROTOCOL_VERSION);
    expect(response.requestId).toBe("req-version-1");
    const body = response.body as { version: string; protocolVersion: number };
    expect(body.version).toBe("0.3.1-fixture");
    expect(body.protocolVersion).toBe(WEBUI_PROTOCOL_VERSION);
    ws.close();
  });

  it("streams sendMessage as ordered event frames and preserves mixed frame bodies", async () => {
    port.sendResult = {
      ok: true,
      source: [
        { dataJson: '{"type":10}' },
        {
          dataJson:
            '{"type":6,"agent_message_chunk":{"msg_id":"m1","msg_content":"Hi"}}',
          cursor: "c1",
        },
        {
          dataJson:
            '{"type":"session_status","session_status":{"type":"finished"}}',
        },
        { messageActionDeltas: [{ action: "open" }] },
        { dataJson: "[DONE]" },
      ],
    };
    const { url } = await bootService();
    const { ws, upgrade } = openClient(url);
    await upgrade;
    const frames: unknown[] = [];
    const completed = new Promise<void>((resolve, reject) => {
      ws.on("message", (raw) => {
        try {
          const frame = JSON.parse(raw.toString("utf8")) as {
            kind: string;
            body?: { dataJson?: string };
          };
          frames.push(frame);
          if (frame.kind === "event" && frame.body?.dataJson === "[DONE]")
            resolve();
        } catch (error) {
          reject(error);
        }
      });
    });
    ws.send(
      JSON.stringify({
        protocolVersion: WEBUI_PROTOCOL_VERSION,
        kind: "request",
        requestId: "req-send",
        operation: "sendMessage",
        body: { id: "session-1", content: "hello" },
      }),
    );
    await completed;
    // A data stream is `event` frames and nothing else. Only the event
    // watcher acknowledges (it has no payload of its own to observe), so a
    // consumer written against the original shape is unaffected.
    expect(frames).toHaveLength(5);
    expect(
      frames.every((frame) => (frame as { kind: string }).kind === "event"),
    ).toBe(true);
    expect(
      (frames[1] as { body: { dataJson: string; cursor: string } }).body
        .dataJson,
    ).toContain('"type":6');
    expect((frames[1] as { body: { cursor: string } }).body.cursor).toBe("c1");
    expect(
      (frames[3] as { body: { messageActionDeltas: unknown[] } }).body
        .messageActionDeltas,
    ).toHaveLength(1);
    ws.close();
  });

  it("enqueues a message through the same authenticated operation surface", async () => {
    const { url } = await bootService();
    const { ws, upgrade } = openClient(url);
    await upgrade;
    const response = await requestOnce(ws, {
      protocolVersion: WEBUI_PROTOCOL_VERSION,
      kind: "request",
      requestId: "req-enqueue",
      operation: "enqueueMessage",
      body: { id: "session-1", content: "wait behind the active turn" },
    });
    expect(response).toMatchObject({
      kind: "response",
      requestId: "req-enqueue",
      body: { itemId: "queued-fixture", status: "queued", position: 1 },
    });
    expect(port.lastEnqueueRequest).toEqual({
      id: "session-1",
      content: "wait behind the active turn",
    });
    ws.close();
  });

  it("returns a running stream iterator when its WebSocket connection closes", async () => {
    let returned = false;
    let resolveReturned!: () => void;
    const returnedOnce = new Promise<void>((resolve) => {
      resolveReturned = resolve;
    });
    const pendingIterator: AsyncIterator<{ readonly dataJson?: string }> = {
      next: () =>
        new Promise<IteratorResult<{ readonly dataJson?: string }>>(
          () => undefined,
        ),
      return: async () => {
        returned = true;
        resolveReturned();
        return { done: true, value: undefined };
      },
    };
    port.sendResult = {
      ok: true,
      source: { [Symbol.asyncIterator]: () => pendingIterator },
    };
    const { url } = await bootService();
    const { ws, upgrade, closed } = openClient(url);
    await upgrade;
    ws.send(
      JSON.stringify({
        protocolVersion: WEBUI_PROTOCOL_VERSION,
        kind: "request",
        requestId: "req-cancel-stream",
        operation: "sendMessage",
        body: { id: "session-1", content: "long running" },
      }),
    );
    await port.sendObserved;
    ws.close();
    await closed;
    // The pump is parked on a `next()` that never settles, so the `finally`
    // in dispatchWebuiFrame cannot be what finalises this iterator — only the
    // connection abort is. Wait for that outcome rather than for a tick count.
    await awaitFinalised(
      returnedOnce,
      "the in-flight stream iterator to be finalised after the socket closed",
    );
    expect(returned).toBe(true);
    expect(port.abortCalls).toBe(0);
  });

  it("finalises a partly delivered stream on disconnect, not only one parked on its first pull", async () => {
    let returned = false;
    let resolveReturned!: () => void;
    const returnedOnce = new Promise<void>((resolve) => {
      resolveReturned = resolve;
    });
    let pulls = 0;
    const pendingIterator: AsyncIterator<{ readonly dataJson?: string }> = {
      next: () => {
        pulls += 1;
        // The first pull is served, so the pump is provably parked on a
        // *later* pull when the socket dies. The abort listener has to
        // finalise the iterator from any position in the pump, not just from
        // the very first one the pre-existing test happens to sit on.
        if (pulls === 1)
          return Promise.resolve({
            done: false,
            value: { dataJson: '{"type":10}' },
          });
        return new Promise<IteratorResult<{ readonly dataJson?: string }>>(
          () => undefined,
        );
      },
      return: async () => {
        returned = true;
        resolveReturned();
        return { done: true, value: undefined };
      },
    };
    port.sendResult = {
      ok: true,
      source: { [Symbol.asyncIterator]: () => pendingIterator },
    };
    const { url } = await bootService();
    const { ws, upgrade, closed } = openClient(url);
    await upgrade;
    // `sendMessage` does not acknowledge its stream, so the first frame on
    // the wire is the first delivered value.
    const firstValue = new Promise<void>((resolve) => {
      const onMessage = (raw: import("ws").RawData) => {
        ws.off("message", onMessage);
        resolve();
      };
      ws.on("message", onMessage);
    });
    ws.send(
      JSON.stringify({
        protocolVersion: WEBUI_PROTOCOL_VERSION,
        kind: "request",
        requestId: "req-cancel-midstream",
        operation: "sendMessage",
        body: { id: "session-1", content: "partly delivered" },
      }),
    );
    await firstValue;
    expect(pulls).toBeGreaterThanOrEqual(1);
    ws.close();
    await closed;
    await awaitFinalised(
      returnedOnce,
      "a partly delivered stream iterator to be finalised after the socket closed",
    );
    expect(returned).toBe(true);
    expect(port.abortCalls).toBe(0);
  });

  it("finalises the stream exactly once when the pump settles after the socket closed", async () => {
    // The two preceding tests park the pump on a `next()` that never settles,
    // so the `finally` in dispatchWebuiFrame never runs and only the abort
    // listener can finalise. A real runtime stream DOES settle — the pull
    // completes or rejects once the connection is gone — and then both the
    // listener and the `finally` reach for `return()`. Finalising an iterator
    // twice is a real double-close on a live subscription, so the count is
    // asserted, not just the fact of finalisation.
    let returnCalls = 0;
    let settlePull!: () => void;
    const pullSettled = new Promise<void>((resolve) => {
      settlePull = resolve;
    });
    let pulls = 0;
    const pendingIterator: AsyncIterator<{ readonly dataJson?: string }> = {
      next: () => {
        pulls += 1;
        if (pulls === 1)
          return Promise.resolve({
            done: false,
            value: { dataJson: '{"type":10}' },
          });
        // Park, then let the test release the pull AFTER the socket is gone.
        // That is the shape that runs the abort listener and the `finally`.
        return pullSettled.then(() => ({ done: true, value: undefined }));
      },
      return: async () => {
        returnCalls += 1;
        return { done: true, value: undefined };
      },
    };
    port.sendResult = {
      ok: true,
      source: { [Symbol.asyncIterator]: () => pendingIterator },
    };
    const { url } = await bootService();
    const { ws, upgrade, closed } = openClient(url);
    await upgrade;
    const firstValue = new Promise<void>((resolve) => {
      const onMessage = (raw: import("ws").RawData) => {
        ws.off("message", onMessage);
        resolve();
      };
      ws.on("message", onMessage);
    });
    ws.send(
      JSON.stringify({
        protocolVersion: WEBUI_PROTOCOL_VERSION,
        kind: "request",
        requestId: "req-finalise-once",
        operation: "sendMessage",
        body: { id: "session-1", content: "settles after disconnect" },
      }),
    );
    await firstValue;
    expect(pulls).toBeGreaterThanOrEqual(1);
    ws.close();
    await closed;
    // Release the parked pull only now: the abort listener has already run,
    // and settling it drives the loop into the `finally`.
    settlePull();
    await awaitFinalised(
      pullSettled,
      "the parked pull to settle after the socket closed",
    );
    // Drain the microtask queue instead of waiting on a clock.
    //
    // The `finally` that could double-finalise is not on a timer: it runs a few
    // microtask hops after the parked pull resolves — abort listener, then the
    // `await iterator.next()` continuation, then the loop's `break`, then the
    // `finally`. Counting microtasks is deterministic; a sleep is not. The
    // 250 ms this used to wait passed locally 8 times and failed on CI, where
    // the whole 50-file suite loads the machine and the clock is simply not a
    // budget this test can spend.
    for (let i = 0; i < 64; i += 1) await Promise.resolve();
    // One macrotask hop as well: `setImmediate` callbacks and promise
    // continuations are not the same queue, and the socket `close` handler
    // reaches the abort listener through the former.
    await new Promise<void>((resolve) => setImmediate(resolve));
    // The count is the point. Asserting only `returnCalls >= 1` would pass
    // against a double-finalise, which is the failure this pins shut.
    expect(returnCalls).toBe(1);
    expect(port.abortCalls).toBe(0);
  });

  it("drives the fresh-page list, selection, history and send sequence over one credential", async () => {
    port.listSessions = async () => ({
      sessions: [
        {
          sessionId: "fresh-session",
          agentName: "main",
          createdAt: 1,
          updatedAt: 2,
        },
      ],
      hasMore: false,
    });
    port.getMessages = async (request) => ({
      messages: [
        {
          msgId: "history-1",
          role: "assistant",
          msgContent: `history for ${request.id}`,
        },
      ],
      hasMore: false,
    });
    port.sendResult = {
      ok: true,
      source: [
        { dataJson: '{"type":10}' },
        {
          dataJson:
            '{"type":6,"agent_message_chunk":{"msg_id":"reply-1","msg_content":"reply"}}',
        },
        { dataJson: "[DONE]" },
      ],
    };
    const { url } = await bootService();
    const { ws, upgrade } = openClient(url);
    await upgrade;
    const request = (requestId: string, operation: string, body: unknown) =>
      requestOnce(ws, {
        protocolVersion: WEBUI_PROTOCOL_VERSION,
        kind: "request",
        requestId,
        operation,
        body,
      });
    const listed = await request("req-page-list", "listSessions", {
      name: "main",
    });
    const selectedId = (
      listed as { body: { sessions: Array<{ sessionId: string }> } }
    ).body.sessions[0]!.sessionId;
    expect(selectedId).toBe("fresh-session");
    const history = await request("req-page-history", "getMessages", {
      id: selectedId,
    });
    expect(
      (history as { body: { messages: Array<{ msgContent?: string }> } }).body
        .messages[0]!.msgContent,
    ).toBe("history for fresh-session");

    const frames: Array<{ kind: string; body?: { dataJson?: string } }> = [];
    const completed = new Promise<void>((resolve, reject) => {
      ws.on("message", (raw) => {
        try {
          const frame = JSON.parse(
            raw.toString("utf8"),
          ) as (typeof frames)[number];
          frames.push(frame);
          if (frame.body?.dataJson === "[DONE]") resolve();
        } catch (error) {
          reject(error);
        }
      });
    });
    ws.send(
      JSON.stringify({
        protocolVersion: WEBUI_PROTOCOL_VERSION,
        kind: "request",
        requestId: "req-page-send",
        operation: "sendMessage",
        body: { id: selectedId, content: "hello" },
      }),
    );
    await completed;
    expect(frames.map((frame) => frame.body?.dataJson)).toEqual([
      '{"type":10}',
      '{"type":6,"agent_message_chunk":{"msg_id":"reply-1","msg_content":"reply"}}',
      "[DONE]",
    ]);

    port.sendResult = {
      ok: false,
      status: 409,
      body: { key: "delivery_closed", message: "The turn delivery is closed." },
    };
    const refused = await request("req-page-refused", "sendMessage", {
      id: selectedId,
      content: "again",
    });
    expect(refused).toMatchObject({
      kind: "error",
      requestId: "req-page-refused",
      code: "delivery_closed",
    });
    ws.close();
  });

  it("executes the shipped client transport against the real service", async () => {
    const workspaceDir = await mkdtemp(
      path.join(os.tmpdir(), "webui-transport-"),
    );
    port.listSessions = async () => ({
      sessions: [
        {
          sessionId: "transport-session",
          agentName: "main",
          createdAt: 1,
          updatedAt: 2,
        },
      ],
      hasMore: false,
    });
    port.getMessages = async (request) => ({
      messages: [
        {
          msgId: "transport-history",
          role: "assistant",
          msgContent: `history for ${request.id}`,
        },
      ],
      hasMore: false,
    });
    port.createSession = async () => ({ sessionId: "transport-created" });
    port.sendResult = {
      ok: true,
      source: [
        { dataJson: '{"type":10}' },
        {
          dataJson:
            '{"type":6,"agent_message_chunk":{"msg_id":"reply","msg_content":"hello"}}',
        },
        { dataJson: "[DONE]" },
      ],
    };
    try {
      const { credential } = await bootService();
      const transport = createWebuiTransport({
        websocketUrl: service.info().boundUrl,
        token: credential.token,
        webSocket: WebSocket as unknown as NonNullable<
          Parameters<typeof createWebuiTransport>[0]["webSocket"]
        >,
      });
      const listed = await transport.loadSessions();
      const selectedId = listed.sessions[0]?.sessionId;
      expect(selectedId).toBe("transport-session");
      const history = await transport.loadMessages({ id: selectedId! });
      expect(history.messages?.[0]?.msgContent).toBe(
        "history for transport-session",
      );
      const created = await transport.createSession({
        name: "main",
        workspaceDir,
      });
      expect(created.sessionId).toBe("transport-created");
      const frames: string[] = [];
      await transport.sendMessage(
        { id: selectedId!, content: "hello" },
        (frame) => frames.push(frame.dataJson ?? ""),
      );
      expect(frames).toEqual([
        '{"type":10}',
        '{"type":6,"agent_message_chunk":{"msg_id":"reply","msg_content":"hello"}}',
        "[DONE]",
      ]);
    } finally {
      await rm(workspaceDir, { recursive: true, force: true });
    }
  });

  it("forwards all authoritative diff operations through service and transport names", async () => {
    const { credential } = await bootService();
    const transport = createWebuiTransport({
      websocketUrl: service.info().boundUrl,
      token: credential.token,
      webSocket: WebSocket as unknown as NonNullable<
        Parameters<typeof createWebuiTransport>[0]["webSocket"]
      >,
    });
    const request = { id: "session-1", assistantMessageId: "assistant-1", changeSetId: "changes-1" };
    expect(await transport.getSessionDiff({ id: "session-1", messageId: "assistant-1" })).toMatchObject({ changeSetId: "changes-1" });
    expect(await transport.getTurnDiff(request)).toMatchObject({ status: "active", changeSetId: "changes-1" });
    expect(await transport.revertTurnDiff(request)).toMatchObject({ success: true, turnDiff: { status: "reverted" } });
    expect(await transport.reapplyTurnDiff(request)).toMatchObject({ success: true, status: "active" });
    expect(port.diffRequests.map((entry) => entry.operation)).toEqual([
      "getSessionDiff",
      "getTurnDiff",
      "revertTurnDiff",
      "reapplyTurnDiff",
    ]);
  });

  it("rejects request and stream promises when the client socket closes without a response", async () => {
    const transport = createWebuiTransport({
      websocketUrl: "ws://127.0.0.1:1",
      token: "fixture-token",
      webSocket: ClosingSocket,
    });
    await expect(transport.loadSessions()).rejects.toThrow(
      "WebUI connection closed before the response",
    );
    await expect(
      transport.sendMessage(
        { id: "session", content: "hello" },
        () => undefined,
      ),
    ).rejects.toThrow("WebUI connection closed before [DONE]");
  });

  it("rejects a unary request when an open WebSocket never returns a response", async () => {
    const transport = createWebuiTransport({
      websocketUrl: "ws://127.0.0.1:1",
      token: "fixture-token",
      requestTimeoutMs: 10,
      webSocket: SilentOpenSocket,
    });
    await expect(transport.loadSessions()).rejects.toThrow(
      "WebUI request timed out after 10ms (listSessions)",
    );
  });

  it("reports the watcher ready only after the server answers the request", async () => {
    // The readiness callback is what gates the "is a turn running?" probe.
    // Firing it when the request is merely written leaves a window where
    // the probe reads "idle" and the `session.start` that follows has
    // nowhere to land — the original frozen-stream defect. Only the
    // server's response means the watcher is registered.
    let socketsOpened = 0;
    let readyCount = 0;
    let sentPayload: { requestId?: unknown } | undefined;
    let socketRef: { deliver: (frame: unknown) => void } | undefined;
    class AckControlledSocket {
      private readonly listeners = new Map<
        "open" | "message" | "error" | "close",
        Array<(event: { data?: unknown }) => void>
      >();
      constructor(_url: string) {
        socketsOpened += 1;
        queueMicrotask(() => this.emit("open", {}));
        socketRef = {
          deliver: (frame) => queueMicrotask(() => this.emit("message", { data: JSON.stringify(frame) })),
        };
      }
      addEventListener(
        type: "open" | "message" | "error" | "close",
        listener: (event: { data?: unknown }) => void,
      ): void {
        this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
      }
      send(data: string): void {
        sentPayload = JSON.parse(data) as { requestId?: unknown };
      }
      close(): void {}
      private emit(
        type: "open" | "message" | "error" | "close",
        event: { data?: unknown },
      ): void {
        for (const listener of this.listeners.get(type) ?? []) listener(event);
      }
    }
    const transport = createWebuiTransport({
      websocketUrl: "ws://127.0.0.1:1",
      token: "fixture-token",
      webSocket: AckControlledSocket,
    });
    const unsubscribe = transport.watchEvents(
      () => undefined,
      () => {
        readyCount += 1;
      },
    );
    for (let tick = 0; tick < 8 && sentPayload === undefined; tick += 1)
      await Promise.resolve();
    // The socket is open and the request is written — still not ready.
    expect(socketsOpened).toBe(1);
    expect(sentPayload?.requestId).toBeTypeOf("string");
    expect(readyCount).toBe(0);

    socketRef?.deliver({
      kind: "response",
      requestId: sentPayload?.requestId,
      body: { ok: true },
    });
    for (let tick = 0; tick < 8 && readyCount === 0; tick += 1) await Promise.resolve();
    expect(readyCount).toBe(1);

    // One signal per connection: a duplicate response must not re-probe.
    socketRef?.deliver({
      kind: "response",
      requestId: sentPayload?.requestId,
      body: { ok: true },
    });
    for (let tick = 0; tick < 4; tick += 1) await Promise.resolve();
    expect(readyCount).toBe(1);
    unsubscribe();
  });

  it("reopens the event subscription when a hidden tab becomes visible", async () => {
    const originalDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
    const listeners = new Map<string, Array<() => void>>();
    const documentStub = {
      visibilityState: "hidden",
      addEventListener: (type: string, listener: () => void) => {
        listeners.set(type, [...(listeners.get(type) ?? []), listener]);
      },
      removeEventListener: (type: string, listener: () => void) => {
        listeners.set(type, (listeners.get(type) ?? []).filter((entry) => entry !== listener));
      },
    } as unknown as {
      visibilityState: string;
      addEventListener: (type: string, listener: () => void) => void;
      removeEventListener: (type: string, listener: () => void) => void;
    };
    Object.defineProperty(globalThis, "document", {
      configurable: true,
      value: documentStub,
    });
    let socketsOpened = 0;
    let reconnects = 0;
    try {
      const transport = createWebuiTransport({
        websocketUrl: "ws://127.0.0.1:1",
        token: "fixture-token",
        webSocket: class extends SilentOpenSocket {
          constructor(url: string) {
            super(url);
            socketsOpened += 1;
          }
        },
      });
      const unsubscribe = transport.watchEvents(() => undefined, () => {
        reconnects += 1;
      });
      await Promise.resolve();
      expect(socketsOpened).toBe(1);
      (documentStub as unknown as { visibilityState: string }).visibilityState = "visible";
      for (const listener of listeners.get("visibilitychange") ?? []) listener();
      await Promise.resolve();
      expect(socketsOpened).toBe(2);
      expect(reconnects).toBe(1);
      unsubscribe();
    } finally {
      if (originalDocument) Object.defineProperty(globalThis, "document", originalDocument);
      else delete (globalThis as { document?: unknown }).document;
    }
  });

  it("terminates WebSocket connections that stop answering heartbeat pings", async () => {
    service = new WebuiService({
      port,
      tcpPort: 0,
      dev: true,
      webSocketHeartbeatIntervalMs: 10,
    });
    const info = await service.start();
    const ws = new WebSocket(
      `${info.boundUrl}/?token=${encodeURIComponent(info.credential.token)}`,
    );
    ws.on("error", () => undefined);
    const opened = once(ws, "open");
    const closed = awaitClose(ws);
    await opened;
    // The ws client normally answers control pings automatically. Disable
    // that response to model a browser whose long-lived connection is dead.
    (
      ws as unknown as {
        _receiver?: { removeAllListeners?: (event: string) => void };
      }
    )._receiver?.removeAllListeners?.("ping");
    await expect(closed).resolves.toMatchObject({ code: 1006, reason: "" });
  });

  it("turns an refused send result into a client-visible error", async () => {
    port.sendResult = {
      ok: false,
      status: 409,
      body: { key: "delivery_closed", message: "The turn delivery is closed." },
    };
    const { url } = await bootService();
    const { ws, upgrade } = openClient(url);
    await upgrade;
    const response = await requestOnce(ws, {
      protocolVersion: WEBUI_PROTOCOL_VERSION,
      kind: "request",
      requestId: "req-refused",
      operation: "sendMessage",
      body: { id: "session-1", content: "hello" },
    });
    expect(response).toMatchObject({
      kind: "error",
      requestId: "req-refused",
      code: "delivery_closed",
      message: "The turn delivery is closed.",
    });
    ws.close();
  });

  it("streams resumeSession as ordered event frames and forwards the cursor the client supplies", async () => {
    // resumeSession shares the wire shape of sendMessage (the harness
    // contract returns the same iterable source — see
    // `cli-service.ts:294-301`). The service forwards the body verbatim
    // and the registered handler resolves to `{stream: ...}` so the
    // service's `for await` loop emits `event` frames with the harness's
    // frames as the body.
    port.resumeResult = {
      ok: true,
      source: [
        { dataJson: '{"type":10}' },
        {
          dataJson:
            '{"type":2,"agent_message":{"msg_id":"replayed","msg_content":"after-c1"}}',
          cursor: "c2",
        },
        { dataJson: "[DONE]" },
      ],
    };
    const { url } = await bootService();
    const { ws, upgrade } = openClient(url);
    await upgrade;
    const frames: unknown[] = [];
    const completed = new Promise<void>((resolve, reject) => {
      ws.on("message", (raw) => {
        try {
          const frame = JSON.parse(raw.toString("utf8")) as {
            kind: string;
            body?: { dataJson?: string; cursor?: string };
          };
          frames.push(frame);
          if (frame.kind === "event" && frame.body?.dataJson === "[DONE]")
            resolve();
        } catch (error) {
          reject(error);
        }
      });
    });
    ws.send(
      JSON.stringify({
        protocolVersion: WEBUI_PROTOCOL_VERSION,
        kind: "request",
        requestId: "req-resume",
        operation: "resumeSession",
        body: { id: "session-1", afterCursor: "c1" },
      }),
    );
    await completed;
    expect(frames).toHaveLength(3);
    expect((frames[1] as { body: { cursor: string } }).body.cursor).toBe("c2");
    // The body the service forwarded to the port is the body the client
    // sent — including `afterCursor`. The harness is what eventually
    // honours it; the service does not rewrite or strip it.
    expect(port.lastResumeRequest).toEqual({
      id: "session-1",
      afterCursor: "c1",
    });
    ws.close();
  });

  it("lets the server-side turn keep running when the client WebSocket closes mid-stream", async () => {
    // Closing a tab must unsubscribe without stopping the turn. The
    // service wires each operation to a per-request `for await` loop
    // (see `service.ts:#handleMessage`), which calls `sendFrame` for
    // every harness frame. `sendFrame` no-ops once the socket is closed,
    // but the harness source keeps emitting until it is exhausted, and
    // the server-side promise of `entry.handle(...)` resolves when the
    // source is done. We assert that promise resolves after the client
    // closes, which means the turn ran to completion on the server
    // side even though the client went away.
    let resolveHarness!: () => void;
    const harnessDone = new Promise<void>((resolve) => {
      resolveHarness = resolve;
    });
    let harnessFrameCount = 0;
    const slowSource = {
      [Symbol.asyncIterator]() {
        return {
          next: async () => {
            harnessFrameCount += 1;
            // Emit three frames then close. The second frame is what
            // the client receives before it closes the socket; the
            // third only lands server-side.
            if (harnessFrameCount === 1)
              return { value: { dataJson: '{"type":10}' }, done: false };
            if (harnessFrameCount === 2)
              return {
                value: {
                  dataJson:
                    '{"type":6,"agent_message_chunk":{"msg_id":"m1","msg_content":"partial"}}',
                },
                done: false,
              };
            resolveHarness();
            return { value: { dataJson: "[DONE]" }, done: true };
          },
        };
      },
    };
    port.sendResult = { ok: true, source: slowSource };
    const { url } = await bootService();
    const { ws, upgrade } = openClient(url);
    await upgrade;
    const receivedBeforeClose = new Promise<unknown>((resolve) => {
      ws.on("message", (raw) => {
        try {
          const frame = JSON.parse(raw.toString("utf8")) as {
            kind: string;
            body?: { dataJson?: string };
          };
          if (frame.body?.dataJson?.includes("partial")) resolve(frame);
        } catch {
          // ignore parse errors
        }
      });
    });
    ws.send(
      JSON.stringify({
        protocolVersion: WEBUI_PROTOCOL_VERSION,
        kind: "request",
        requestId: "req-midstream-close",
        operation: "sendMessage",
        body: { id: "session-1", content: "hello" },
      }),
    );
    // Wait for the client to receive a frame, then close mid-stream.
    await receivedBeforeClose;
    ws.close();
    // The harness stream must still drain to completion on the server
    // side even though the client went away. If it were tied to the
    // socket lifecycle this promise would never resolve.
    await harnessDone;
    expect(harnessFrameCount).toBe(3);
  });

  it("serves the built client only with the credential and injects runtime configuration", async () => {
    const { credential } = await bootService();
    const response = await fetch(
      `http://127.0.0.1:${service.info().tcpPort}/?token=${encodeURIComponent(credential.token)}`,
    );
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain("__WEBUI_CONFIG__");
    expect(html).toContain(credential.token);
    expect(html).toContain("client.js");
    expect(
      (await fetch(`http://127.0.0.1:${service.info().tcpPort}/`)).status,
    ).toBe(401);
  });

  it("serves the linked assets without a credential when dev mode is on", async () => {
    // This is the test that would have caught the blank page. The served
    // HTML references `./styles.css` and `./client.js` as relative URLs —
    // a real browser resolves them without ever seeing the `?token=`
    // query. Without dev mode the asset requests 401 and the page is
    // unstyled; with dev mode they must succeed without inventing query
    // parameters.
    //
    // The assets are read from the `clientDir` override so the test does
    // not depend on which source-layout path `findClientDirectory()`
    // happens to pick — both modes are exercised against the same
    // hermetic fixture.
    const fixtureDir = await mkdtemp(
      path.join(os.tmpdir(), "webui-clientdir-"),
    );
    const { writeFile } = await import("node:fs/promises");
    await writeFile(
      path.join(fixtureDir, "index.html"),
      "<!doctype html><html><head></head><body data-fixture='true'></body></html>",
    );
    await writeFile(path.join(fixtureDir, "client.js"), "// client-fixture");
    await writeFile(
      path.join(fixtureDir, "styles.css"),
      "/* styles-fixture */",
    );
    try {
      const devService = new WebuiService({
        port,
        dev: true,
        clientDir: fixtureDir,
      });
      try {
        await devService.start();
        const port1 = devService.info().tcpPort;
        for (const path of ["/", "/client.js", "/styles.css"]) {
          const response = await fetch(`http://127.0.0.1:${port1}${path}`);
          expect(response.status, `dev-mode GET ${path}`).toBe(200);
        }
      } finally {
        await devService.close();
      }
      // Default mode still requires the credential on the same paths.
      const prodService = new WebuiService({
        port,
        clientDir: fixtureDir,
      });
      try {
        await prodService.start();
        const port2 = prodService.info().tcpPort;
        for (const path of ["/", "/client.js", "/styles.css"]) {
          const response = await fetch(`http://127.0.0.1:${port2}${path}`);
          expect(response.status, `default-mode GET ${path}`).toBe(401);
        }
      } finally {
        await prodService.close();
      }
    } finally {
      await rm(fixtureDir, { recursive: true, force: true });
    }
  });

  it("reads assets from the supplied clientDir override rather than the discovered path", async () => {
    // The brief asks for the built-artifact path to be testable so the
    // blank-page regression cannot come back. We stage a small fixture
    // and assert the override reaches the served page without the
    //    credential the previous mode demanded.
    const workspaceDir = await mkdtemp(
      path.join(os.tmpdir(), "webui-clientdir-"),
    );
    try {
      const { writeFile } = await import("node:fs/promises");
      await writeFile(
        path.join(workspaceDir, "index.html"),
        "<!doctype html><html><head></head><body data-fixture='true'></body></html>",
      );
      await writeFile(
        path.join(workspaceDir, "client.js"),
        "// client-fixture",
      );
      await writeFile(
        path.join(workspaceDir, "styles.css"),
        "/* styles-fixture */",
      );
      service = new WebuiService({
        port,
        dev: true,
        clientDir: workspaceDir,
      });
      await service.start();
      const tcpPort = service.info().tcpPort;
      const html = await (await fetch(`http://127.0.0.1:${tcpPort}/`)).text();
      expect(html).toContain("data-fixture='true'");
      const js = await (
        await fetch(`http://127.0.0.1:${tcpPort}/client.js`)
      ).text();
      expect(js).toBe("// client-fixture");
      const css = await (
        await fetch(`http://127.0.0.1:${tcpPort}/styles.css`)
      ).text();
      expect(css).toBe("/* styles-fixture */");
    } finally {
      await rm(workspaceDir, { recursive: true, force: true });
    }
  });

  // `GET /workspace-file` serves one workspace file as a byte-range-capable
  // resource, for the media preview and the HTML preview in the workspace
  // panel. The route is dispatched *after* the loopback, origin and credential
  // checks in `#serveClient`, so every assertion here goes out over a real
  // socket: what is under test is bytes and headers on the wire, not the
  // return value of an internal helper. The three properties that make the
  // route safe enough to exist are all wire-level:
  //
  //   * a path that leaves the workspace never resolves to bytes,
  //   * a range request answers the bytes it was asked for and nothing else,
  //   * an unrecognised file is never rendered, because the media type comes
  //     from a whitelist with an `application/octet-stream` floor rather than
  //     from the guessing `contentType()` the WebUI's own bundle needs.
  describe("workspace file resource", () => {
    // 21 bytes, so `bytes=0-4` and the suffix form `bytes=-5` cut distinct,
    // checkable slices out of the start and the end of the same file.
    const TEXT = "0123456789abcdefghij\n";
    const stagedDirs: string[] = [];

    afterEach(async () => {
      while (stagedDirs.length > 0) {
        const dir = stagedDirs.pop();
        if (dir) await rm(dir, { recursive: true, force: true });
      }
    });

    /**
     * Boot the real service and stage a temp tree for it to serve.
     *
     * The tree carries two things a plain `mkdtemp` root would not: a sibling
     * directory whose *name* starts with the root's name (`<root>-sibling`),
     * and a second unrelated temp directory outside the root. The sibling is
     * the case a `..`-segment check alone misses — `path.resolve` collapses
     * both `<root>/../<root>-sibling/secret.txt` and the absolute form
     * `<root>-sibling/secret.txt` to a real path outside the root, and only
     * the `target === root || target.startsWith(root + path.sep)` comparison
     * rejects them, because both start with the root as a plain *string*.
     */
    async function bootWorkspaceTree(): Promise<WorkspaceFileTree> {
      const { credential } = await bootService();
      const root = await mkdtemp(path.join(os.tmpdir(), "webui-wsfile-"));
      const sibling = `${root}-sibling`;
      const outside = await mkdtemp(path.join(os.tmpdir(), "webui-wsfile-outside-"));
      stagedDirs.push(root, sibling, outside);
      await mkdir(sibling);
      await mkdir(path.join(root, "nested"));
      await writeFile(path.join(root, "notes.txt"), TEXT);
      await writeFile(path.join(root, "page.html"), "<!doctype html><p>preview</p>\n");
      await writeFile(path.join(root, "frame.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
      // Two shapes that must land on the whitelist floor: an extension the
      // table has never heard of, and no extension at all.
      await writeFile(path.join(root, "blob.unknownext"), "not on the list\n");
      await writeFile(path.join(root, "LICENSE"), "no extension at all\n");
      await writeFile(path.join(sibling, "secret.txt"), "sibling secret\n");
      await writeFile(path.join(outside, "secret.txt"), "outside secret\n");
      return {
        endpoint: `http://127.0.0.1:${service.info().tcpPort}/workspace-file`,
        token: credential.token,
        root,
        sibling,
        outside,
      };
    }

    /**
     * Build the request URL. An empty `token`/`dir`/`path` is omitted from the
     * query string, which is what exercises the parameter-level failures
     * without hand-rolling one.
     */
    function fileUrl(
      tree: WorkspaceFileTree,
      relative: string,
      options?: {
        readonly token?: string | undefined;
        readonly dir?: string | undefined;
      },
    ): string {
      const params = new URLSearchParams();
      // An empty `dir`/`path`/`token` is left out of the query string
      // entirely, which is how the parameter-level failures get reached.
      const dir = options?.dir === undefined ? tree.root : options.dir;
      if (dir) params.set("dir", dir);
      if (relative) params.set("path", relative);
      const token = options?.token === undefined ? tree.token : options.token;
      if (token) params.set("token", token);
      return `${tree.endpoint}?${params.toString()}`;
    }

    /** Read the body as the bytes that arrived, never as a decoded string. */
    async function readBody(response: Response): Promise<Buffer> {
      return Buffer.from(await response.arrayBuffer());
    }

    it("requires the per-start credential before resolving a path", async () => {
      const tree = await bootWorkspaceTree();

      const anonymous = await fetch(fileUrl(tree, "notes.txt", { token: "" }));
      expect(anonymous.status).toBe(401);

      const wrong = await fetch(
        fileUrl(tree, "notes.txt", { token: "definitely-not-it" }),
      );
      expect(wrong.status).toBe(401);
    });

    it("serves a whole file with its whitelisted media type and no partial framing", async () => {
      const tree = await bootWorkspaceTree();

      const response = await fetch(fileUrl(tree, "notes.txt"));
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe("text/plain; charset=utf-8");
      expect(response.headers.get("content-length")).toBe(String(TEXT.length));
      expect(response.headers.get("content-range")).toBeNull();
      expect((await readBody(response)).toString("utf8")).toBe(TEXT);
      // The security headers ride on every response, not only on HTML: a
      // previewed artifact must never be able to sniff its way to a rendering
      // type, and a range body must not be replayed against a later edit.
      expect(response.headers.get("x-content-type-options")).toBe("nosniff");
      expect(response.headers.get("accept-ranges")).toBe("bytes");
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(response.headers.get("content-security-policy")).toBe("sandbox");
    });

    it("serves a zero-byte file as an empty 200 and refuses a range against it", async () => {
      // A zero-byte file has no last byte, so `total - 1` is -1: the read
      // stream used to be handed that and rejected it with ERR_OUT_OF_RANGE,
      // which rejected the response promise and left the request hanging as an
      // unhandled rejection. A freshly created empty file in the workspace is
      // an ordinary thing for the file browser to be asked for.
      const tree = await bootWorkspaceTree();
      await writeFile(path.join(tree.root, "empty.txt"), "");

      const response = await fetch(fileUrl(tree, "empty.txt"));
      expect(response.status).toBe(200);
      expect(response.headers.get("content-length")).toBe("0");
      expect(response.headers.get("content-security-policy")).toBe("sandbox");
      expect((await readBody(response)).length).toBe(0);

      // A range cannot select a byte that does not exist, so this is
      // unsatisfiable rather than answerable — and its Content-Range has to
      // stay spellable, which is why it is not a `bytes 0--1/0`.
      for (const header of ["bytes=0-", "bytes=-5"]) {
        const ranged = await fetch(fileUrl(tree, "empty.txt"), {
          headers: { Range: header },
        });
        expect(ranged.status, `Range: ${header}`).toBe(416);
        expect(ranged.headers.get("content-range"), `Range: ${header}`).toBe("bytes */0");
      }
    });

    it("answers a bounded range with exactly those bytes and the matching Content-Range", async () => {
      const tree = await bootWorkspaceTree();

      const response = await fetch(fileUrl(tree, "notes.txt"), {
        headers: { Range: "bytes=0-4" },
      });
      expect(response.status).toBe(206);
      expect(response.headers.get("content-range")).toBe(`bytes 0-4/${TEXT.length}`);
      expect(response.headers.get("content-length")).toBe("5");
      const body = await readBody(response);
      expect(body.length).toBe(5);
      expect(body.toString("utf8")).toBe(TEXT.slice(0, 5));
    });

    it("answers a suffix range with the final bytes", async () => {
      const tree = await bootWorkspaceTree();

      const response = await fetch(fileUrl(tree, "notes.txt"), {
        headers: { Range: "bytes=-5" },
      });
      expect(response.status).toBe(206);
      expect(response.headers.get("content-range")).toBe(
        `bytes ${TEXT.length - 5}-${TEXT.length - 1}/${TEXT.length}`,
      );
      const body = await readBody(response);
      expect(body.length).toBe(5);
      expect(body.toString("utf8")).toBe(TEXT.slice(-5));
    });

    it("refuses a range it cannot satisfy, and a reversed one, with 416", async () => {
      const tree = await bootWorkspaceTree();

      const pastTheEnd = await fetch(fileUrl(tree, "notes.txt"), {
        headers: { Range: "bytes=999999-" },
      });
      expect(pastTheEnd.status).toBe(416);
      expect(pastTheEnd.headers.get("content-range")).toBe(`bytes */${TEXT.length}`);
      expect((await readBody(pastTheEnd)).length).toBe(0);

      const reversed = await fetch(fileUrl(tree, "notes.txt"), {
        headers: { Range: "bytes=4-2" },
      });
      expect(reversed.status).toBe(416);
      expect(reversed.headers.get("content-range")).toBe(`bytes */${TEXT.length}`);

      // `bytes=-` parses as a range spec that names no bytes at all — the
      // suffix length is missing rather than malformed — so it lands on the
      // unsatisfiable side of the split below, not the unparseable one.
      const empty = await fetch(fileUrl(tree, "notes.txt"), {
        headers: { Range: "bytes=-" },
      });
      expect(empty.status).toBe(416);
      expect(empty.headers.get("content-range")).toBe(`bytes */${TEXT.length}`);
    });

    it("refuses a path that walks out of the workspace with `..`", async () => {
      const tree = await bootWorkspaceTree();
      const target = `../${path.basename(tree.outside)}/secret.txt`;
      // The file is real and outside the root, so the 403 below is a decision
      // about the path rather than a missing-file accident.
      await expect(
        readFile(path.join(tree.outside, "secret.txt"), "utf8"),
      ).resolves.toBe("outside secret\n");

      const response = await fetch(fileUrl(tree, target));
      expect(response.status).toBe(403);
      expect((await response.text()).includes("outside secret")).toBe(false);
    });

    it("refuses a sibling that merely shares the root's name prefix", async () => {
      const tree = await bootWorkspaceTree();
      // The absolute spelling is the sharp one: it starts with the root as a
      // plain string, so a `target.startsWith(root)` check would let it
      // through, and the `+ path.sep` comparison is what rejects it.
      const escapes = [
        path.join(tree.sibling, "secret.txt"),
        `../${path.basename(tree.sibling)}/secret.txt`,
      ];

      for (const target of escapes) {
        const response = await fetch(fileUrl(tree, target));
        expect(response.status, `escape via ${target}`).toBe(403);
        expect((await response.text()).includes("sibling secret")).toBe(false);
      }
    });

    it("falls back to application/octet-stream for a type the whitelist has never heard of", async () => {
      const tree = await bootWorkspaceTree();

      for (const name of ["blob.unknownext", "LICENSE"]) {
        const response = await fetch(fileUrl(tree, name));
        expect(response.status, `serve ${name}`).toBe(200);
        const type = response.headers.get("content-type");
        expect(type, `type for ${name}`).toBe("application/octet-stream");
        // The whole point of the separate table: an unrecognised file must
        // not be guessed into a rendering type the way `contentType()` guesses
        // the WebUI's own bundle.
        expect(type ?? "").not.toContain("text/html");
      }
    });

    it("serves HTML in a script sandbox that cannot read the framing page", async () => {
      const tree = await bootWorkspaceTree();

      const response = await fetch(fileUrl(tree, "page.html"));
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe("text/html; charset=utf-8");
      // `allow-scripts` so the previewed document runs, but no
      // `allow-same-origin`: without it the document lands in an opaque
      // origin and cannot reach `window.__WEBUI_CONFIG__.token`, which would
      // hand it the whole WebUI session.
      expect(response.headers.get("content-security-policy")).toBe(
        "sandbox allow-scripts",
      );
    });

    it("sandboxes a non-HTML type without the allow-scripts variant", async () => {
      const tree = await bootWorkspaceTree();

      for (const name of ["notes.txt", "frame.png"]) {
        const response = await fetch(fileUrl(tree, name));
        expect(response.status, `serve ${name}`).toBe(200);
        const policy = response.headers.get("content-security-policy");
        expect(policy, `policy for ${name}`).toBe("sandbox");
        // Exactly `sandbox`: media in an iframe is already inert, and granting
        // scripts to it would be a grant nothing needs.
        expect(policy ?? "").not.toContain("allow-scripts");
      }
    });

    it("404s a directory or a missing file rather than reading something else", async () => {
      const tree = await bootWorkspaceTree();

      const directory = await fetch(fileUrl(tree, "nested"));
      expect(directory.status).toBe(404);

      // The root itself passes the resolve check (`target === root`), so this
      // also pins that the `isFile()` gate is what rejects it, rather than the
      // path comparison.
      const rootItself = await fetch(fileUrl(tree, "."));
      expect(rootItself.status).toBe(404);

      const missing = await fetch(fileUrl(tree, "absent.txt"));
      expect(missing.status).toBe(404);
    });

    it("400s when either dir or path is missing", async () => {
      const tree = await bootWorkspaceTree();

      const withoutDir = await fetch(fileUrl(tree, "notes.txt", { dir: "" }));
      expect(withoutDir.status).toBe(400);

      const withoutPath = await fetch(fileUrl(tree, ""));
      expect(withoutPath.status).toBe(400);
    });

    it("answers HEAD with the headers and no body, and 405s any other method", async () => {
      const tree = await bootWorkspaceTree();

      const head = await fetch(fileUrl(tree, "notes.txt"), { method: "HEAD" });
      expect(head.status).toBe(200);
      expect(head.headers.get("content-length")).toBe(String(TEXT.length));
      expect(head.headers.get("content-type")).toBe("text/plain; charset=utf-8");
      expect((await readBody(head)).length).toBe(0);

      for (const method of ["POST", "PUT", "DELETE"]) {
        const response = await fetch(fileUrl(tree, "notes.txt"), { method });
        expect(response.status, `${method} /workspace-file`).toBe(405);
      }
    });

    it("serves the whole file for a multi-range or unparseable Range header", async () => {
      // The stated design: a single range only, and anything that is not one
      // parseable single range is answered with the whole file rather than
      // `multipart/byteranges`. Media elements never ask for a multi-range, so
      // a full 200 is a correct, if less efficient, answer to the same bytes.
      const tree = await bootWorkspaceTree();

      for (const header of ["bytes=0-1,4-5", "bytes=abc", "items=0-4"]) {
        const response = await fetch(fileUrl(tree, "notes.txt"), {
          headers: { Range: header },
        });
        expect(response.status, `Range: ${header}`).toBe(200);
        expect(response.headers.get("content-type"), `Range: ${header}`).toBe(
          "text/plain; charset=utf-8",
        );
        expect(response.headers.get("content-range"), `Range: ${header}`).toBeNull();
        expect(
          (await readBody(response)).toString("utf8"),
          `Range: ${header}`,
        ).toBe(TEXT);
      }
    });
  });

  it("accepts a websocket upgrade without a credential when dev mode is on", async () => {
    // The HTTP asset path is only half of the contract — the WebSocket
    // upgrade must follow the same gate so the runtime configuration the
    // page boots with can actually connect.
    service = new WebuiService({ port, dev: true });
    await service.start();
    const url = `ws://127.0.0.1:${service.info().tcpPort}`;
    const { upgrade } = openClient(url);
    await upgrade;
  });

  it("lists sessions through the narrow port and preserves cursor paging", async () => {
    const calls: WebuiSessionListRequest[] = [];
    const pages = [
      {
        sessions: [
          { sessionId: "new", agentName: "main", createdAt: 20, updatedAt: 30 },
        ],
        hasMore: true,
        nextCursor: "cursor-2",
      },
      {
        sessions: [
          { sessionId: "old", agentName: "main", createdAt: 10, updatedAt: 15 },
        ],
        hasMore: false,
      },
    ];
    port.listSessions = async (request): Promise<WebuiSessionPage> => {
      calls.push(request);
      const page = pages[calls.length - 1];
      if (!page) throw new Error("expected page");
      return page;
    };
    const { url } = await bootService();
    const { ws, upgrade } = openClient(url);
    await upgrade;
    const request = (requestId: string, body: unknown) =>
      requestOnce(ws, {
        protocolVersion: WEBUI_PROTOCOL_VERSION,
        kind: "request",
        requestId,
        operation: "listSessions",
        body,
      });
    const first = await request("req-list-1", { name: "main", limit: 1 });
    const second = await request("req-list-2", {
      name: "main",
      limit: 1,
      cursor: "cursor-2",
    });
    expect((first as { body: (typeof pages)[0] }).body.nextCursor).toBe(
      "cursor-2",
    );
    expect(
      (second as { body: (typeof pages)[1] }).body.sessions[0]?.sessionId,
    ).toBe("old");
    expect(calls).toEqual([
      { name: "main", limit: 1 },
      { name: "main", limit: 1, cursor: "cursor-2" },
    ]);
    ws.close();
  });

  it("creates a session only with an existing absolute directory and forwards the narrow request", async () => {
    const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "webui-create-"));
    const calls: WebuiCreateSessionRequest[] = [];
    port.createSession = async (request) => {
      calls.push(request);
      return {
        session: {
          sessionId: "created-session",
          workspaceDir: request.workspaceDir,
        },
      };
    };
    try {
      const { url } = await bootService();
      const { ws, upgrade } = openClient(url);
      await upgrade;
      const request = (requestId: string, body: unknown) =>
        requestOnce(ws, {
          protocolVersion: WEBUI_PROTOCOL_VERSION,
          kind: "request",
          requestId,
          operation: "createSession",
          body,
        });
      const created = await request("req-create", {
        name: " main ",
        workspaceDir: ` ${workspaceDir} `,
        teamModeOff: false,
        ignored: true,
      });
      expect(
        (created as { body: { session: { sessionId: string } } }).body.session
          .sessionId,
      ).toBe("created-session");
      expect(calls).toEqual([{ name: "main", workspaceDir, teamModeOff: false }]);
      const relative = await request("req-create-relative", {
        name: "main",
        workspaceDir: "relative",
      });
      expect((relative as { code: string }).code).toBe(
        WebuiErrorCode.invalidBody,
      );
      const currentDirectory = await request("req-create-current-directory", {
        name: "main",
        workspaceDir: ".",
      });
      expect((currentDirectory as { code: string }).code).toBe(
        WebuiErrorCode.invalidBody,
      );
      expect(calls).toHaveLength(1);
      const missing = await request("req-create-missing", {
        name: "main",
        workspaceDir: path.join(workspaceDir, "missing"),
      });
      expect((missing as { code: string }).code).toBe(
        WebuiErrorCode.invalidBody,
      );
      const absent = await request("req-create-absent", {
        name: "",
        workspaceDir,
      });
      expect((absent as { code: string }).code).toBe(
        WebuiErrorCode.invalidBody,
      );
      expect(calls).toHaveLength(1);
      ws.close();
    } finally {
      await rm(workspaceDir, { recursive: true, force: true });
    }
  });

  it("rejects a session-list body without the required harness name", async () => {
    const { url } = await bootService();
    const { ws, upgrade } = openClient(url);
    await upgrade;
    const response = await requestOnce(ws, {
      protocolVersion: WEBUI_PROTOCOL_VERSION,
      kind: "request",
      requestId: "req-list-invalid",
      operation: "listSessions",
      body: { limit: 10 },
    });
    if (!isWebuiFrame(response)) throw new Error("expected frame");
    expect(response.kind).toBe("error");
    if (response.kind !== "error") throw new Error("expected error frame");
    expect(response.code).toBe(WebuiErrorCode.invalidBody);
    ws.close();
  });

  it("opens a session and reads message history with the CLI-level id and before cursor", async () => {
    const sessionCalls: WebuiSessionLookupRequest[] = [];
    const messageCalls: WebuiMessagesRequest[] = [];
    port.getSession = async (request) => {
      sessionCalls.push(request);
      return { session: { sessionId: request.id, title: "History" } };
    };
    port.getMessages = async (request) => {
      messageCalls.push(request);
      return request.before
        ? {
            messages: [{ msgId: "older", role: "user", msgContent: "Earlier" }],
            hasMore: false,
          }
        : {
            messages: [
              { msgId: "newer", role: "assistant", msgContent: "Later" },
            ],
            nextCursor: "before-1",
            hasMore: true,
          };
    };
    const { url } = await bootService();
    const { ws, upgrade } = openClient(url);
    await upgrade;
    const request = (requestId: string, operation: string, body: unknown) =>
      requestOnce(ws, {
        protocolVersion: WEBUI_PROTOCOL_VERSION,
        kind: "request",
        requestId,
        operation,
        body,
      });
    const sessionResponse = await request("req-session", "getSession", {
      id: "session-1",
    });
    const first = await request("req-messages-1", "getMessages", {
      id: "session-1",
      limit: 1,
    });
    const second = await request("req-messages-2", "getMessages", {
      id: "session-1",
      limit: 1,
      before: "before-1",
    });
    expect(
      (sessionResponse as { body: { session: { title: string } } }).body.session
        .title,
    ).toBe("History");
    expect((first as { body: WebuiMessagesResult }).body.nextCursor).toBe(
      "before-1",
    );
    expect(
      (second as { body: WebuiMessagesResult }).body.messages?.[0]?.msgId,
    ).toBe("older");
    expect(sessionCalls).toEqual([{ id: "session-1" }]);
    expect(messageCalls).toEqual([
      { id: "session-1", limit: 1 },
      { id: "session-1", limit: 1, before: "before-1" },
    ]);
    ws.close();
  });

  it("rejects session history bodies that use sessionId instead of id", async () => {
    const { url } = await bootService();
    const { ws, upgrade } = openClient(url);
    await upgrade;
    const response = await requestOnce(ws, {
      protocolVersion: WEBUI_PROTOCOL_VERSION,
      kind: "request",
      requestId: "req-messages-invalid",
      operation: "getMessages",
      body: { sessionId: "wrong-field" },
    });
    if (!isWebuiFrame(response)) throw new Error("expected frame");
    expect(response.kind).toBe("error");
    if (response.kind !== "error") throw new Error("expected error frame");
    expect(response.code).toBe(WebuiErrorCode.invalidBody);
    ws.close();
  });

  it("routes workspace and canvas operations through the harness port", async () => {
    const { url } = await bootService();
    const { ws, upgrade } = openClient(url);
    await upgrade;
    const request = (requestId: string, operation: string, body: unknown) =>
      requestOnce(ws, { protocolVersion: WEBUI_PROTOCOL_VERSION, kind: "request", requestId, operation, body });
    const tree = await request("req-tree", "listWorkspaceFileTree", { workspaceDir: "/tmp" });
    const content = await request("req-read", "readWorkspaceFile", { workspaceDir: "/tmp", path: "README.md" });
    const canvas = await request("req-canvas", "readCanvas", { sessionId: "fixture-session" });
    const applied = await request("req-apply", "applyCanvas", { sessionId: "fixture-session", operation: { operationId: "op-1", mutations: [] } });
    expect((tree as { body: Array<{ path: string }> }).body[0]?.path).toBe("README.md");
    expect((content as { body: { content: string } }).body.content).toContain("fixture content");
    expect((canvas as { body: { sessionId: string } }).body.sessionId).toBe("fixture-session");
    expect((applied as { body: { operationId: string } }).body.operationId).toBe("op-1");
    const denied = await request("req-read-denied", "readWorkspaceFile", { workspaceDir: "/tmp", path: "../../etc/passwd" });
    expect((denied as { kind: string }).kind).toBe("error");
    ws.close();
  });

  it("validates and forwards workspace review requests with their snapshot identity", async () => {
    assert.deepEqual(getWorkspaceReviewSummaryOperation.validate({ workspaceDir: " " }), {
      ok: false,
      code: WebuiErrorCode.invalidBody,
      message: "workspaceDir is required",
    });
    assert.deepEqual(listWorkspaceReviewFileDiffsOperation.validate({ workspaceDir: "/repo", fileIds: ["file-1"] }), {
      ok: false,
      code: WebuiErrorCode.invalidBody,
      message: "workspaceDir and reviewSnapshotId are required",
    });
    assert.deepEqual(listWorkspaceReviewFileDiffsOperation.validate({ workspaceDir: "/repo", reviewSnapshotId: "snap-1", fileIds: [] }), {
      ok: false,
      code: WebuiErrorCode.invalidBody,
      message: "fileIds must be a non-empty string array",
    });
    assert.deepEqual(getWorkspaceReviewFileContentOperation.validate({ workspaceDir: "/repo", reviewSnapshotId: "snap-1", fileId: "file-1", side: "other" }), {
      ok: false,
      code: WebuiErrorCode.invalidBody,
      message: "side must be old or new",
    });
    assert.deepEqual(searchWorkspaceReviewDiffsOperation.validate({ workspaceDir: "/repo", reviewSnapshotId: "snap-1", includeUntrackedFiles: true }), {
      ok: false,
      code: WebuiErrorCode.invalidBody,
      message: "query must be a string",
    });
    assert.deepEqual(searchWorkspaceReviewDiffsOperation.validate({ workspaceDir: "/repo", reviewSnapshotId: "snap-1", query: "needle", includeUntrackedFiles: "yes" }), {
      ok: false,
      code: WebuiErrorCode.invalidBody,
      message: "includeUntrackedFiles must be a boolean",
    });
    assert.deepEqual(searchWorkspaceReviewDiffsOperation.validate({ workspaceDir: "/repo", reviewSnapshotId: "snap-1", query: "needle", includeUntrackedFiles: true, pageIndex: -1 }), {
      ok: false,
      code: WebuiErrorCode.invalidBody,
      message: "pageIndex must be a non-negative integer",
    });
    assert.deepEqual(searchWorkspaceReviewDiffsOperation.validate({ workspaceDir: "/repo", reviewSnapshotId: "snap-1", query: "needle", includeUntrackedFiles: true, pageSize: 0 }), {
      ok: false,
      code: WebuiErrorCode.invalidBody,
      message: "pageSize must be a positive integer",
    });

    const { url } = await bootService();
    const { ws, upgrade } = openClient(url);
    await upgrade;
    const request = (requestId: string, operation: string, body: unknown) =>
      requestOnce(ws, { protocolVersion: WEBUI_PROTOCOL_VERSION, kind: "request", requestId, operation, body });
    const summary = await request("req-review-summary", "getWorkspaceReviewSummary", { workspaceDir: "/repo" });
    expect((summary as { body: { reviewSnapshotId: string; files: unknown[] } }).body).toMatchObject({ reviewSnapshotId: "fixture-snapshot", files: [{ fileId: "file-1" }] });
    const diffs = await request("req-review-diffs", "listWorkspaceReviewFileDiffs", { workspaceDir: "/repo", reviewSnapshotId: "fixture-snapshot", fileIds: ["file-1"] });
    expect((diffs as { body: { reviewSnapshotId: string } }).body.reviewSnapshotId).toBe("fixture-snapshot");
    const content = await request("req-review-content", "getWorkspaceReviewFileContent", { workspaceDir: "/repo", reviewSnapshotId: "fixture-snapshot", fileId: "file-1", side: "new" });
    expect((content as { body: { content: string; reviewSnapshotId: string } }).body).toMatchObject({ content: "fixture source", reviewSnapshotId: "fixture-snapshot" });
    const search = await request("req-review-search", "searchWorkspaceReviewDiffs", { workspaceDir: "/repo", reviewSnapshotId: "fixture-snapshot", query: "needle", includeUntrackedFiles: true });
    expect((search as { body: { matchedFiles: unknown[]; reviewSnapshotId: string } }).body).toMatchObject({ reviewSnapshotId: "fixture-snapshot", matchedFiles: [{ path: "src/index.ts" }] });
    expect(port.reviewRequests).toEqual([
      { operation: "getWorkspaceReviewSummary", body: { workspaceDir: "/repo" } },
      { operation: "listWorkspaceReviewFileDiffs", body: { workspaceDir: "/repo", reviewSnapshotId: "fixture-snapshot", fileIds: ["file-1"] } },
      { operation: "getWorkspaceReviewFileContent", body: { workspaceDir: "/repo", reviewSnapshotId: "fixture-snapshot", fileId: "file-1", side: "new" } },
      { operation: "searchWorkspaceReviewDiffs", body: { workspaceDir: "/repo", reviewSnapshotId: "fixture-snapshot", query: "needle", includeUntrackedFiles: true } },
    ]);
    ws.close();
  });

  it("surfaces workspace review runtime errors as harness errors", async () => {
    port.reviewError = new Error("review snapshot expired");
    const { url } = await bootService();
    const { ws, upgrade } = openClient(url);
    await upgrade;
    const response = await requestOnce(ws, { protocolVersion: WEBUI_PROTOCOL_VERSION, kind: "request", requestId: "req-review-error", operation: "listWorkspaceReviewFileDiffs", body: { workspaceDir: "/repo", reviewSnapshotId: "expired", fileIds: ["file-1"] } });
    expect(response).toMatchObject({ kind: "error", code: WebuiErrorCode.harnessError, message: "review snapshot expired" });
    ws.close();
  });

  it("rejects a request whose operation is outside the allowlist", async () => {
    const { url } = await bootService();
    const { ws, upgrade } = openClient(url);
    await upgrade;
    const request = {
      protocolVersion: WEBUI_PROTOCOL_VERSION,
      kind: "request",
      requestId: "req-unknown",
      operation: "not-an-operation",
      body: {},
    };
    const response = await requestOnce(ws, request);
    if (!isWebuiFrame(response)) throw new Error("expected frame");
    expect(response.kind).toBe("error");
    if (response.kind !== "error") throw new Error("expected error frame");
    expect(response.code).toBe(WebuiErrorCode.unknownOperation);
    ws.close();
  });

  it("rejects a version request whose body carries fields", async () => {
    const { url } = await bootService();
    const { ws, upgrade } = openClient(url);
    await upgrade;
    const request = {
      protocolVersion: WEBUI_PROTOCOL_VERSION,
      kind: "request",
      requestId: "req-version-with-body",
      operation: "version",
      body: { sneaky: true },
    };
    const response = await requestOnce(ws, request);
    if (!isWebuiFrame(response)) throw new Error("expected frame");
    expect(response.kind).toBe("error");
    if (response.kind !== "error") throw new Error("expected error frame");
    expect(response.code).toBe(WebuiErrorCode.invalidBody);
    ws.close();
  });

  it("rejects frames whose protocolVersion does not match the service", async () => {
    const { url } = await bootService();
    const { ws, upgrade } = openClient(url);
    await upgrade;
    const request = {
      protocolVersion: 99,
      kind: "request",
      requestId: "req-bad-protocol",
      operation: "version",
      body: undefined,
    };
    const response = await requestOnce(ws, request);
    if (!isWebuiFrame(response)) throw new Error("expected frame");
    expect(response.kind).toBe("error");
    if (response.kind !== "error") throw new Error("expected error frame");
    expect(response.code).toBe(WebuiErrorCode.protocolMismatch);
    ws.close();
  });

  it("rejects frames that are not valid JSON", async () => {
    const { url } = await bootService();
    const { ws, upgrade } = openClient(url);
    await upgrade;
    const responsePromise = new Promise<unknown>((resolve, reject) => {
      const onMessage = (raw: RawData) => {
        ws.off("message", onMessage);
        ws.off("error", onError);
        try {
          resolve(JSON.parse(raw.toString("utf8")));
        } catch (error) {
          reject(error);
        }
      };
      const onError = (error: Error) => {
        ws.off("message", onMessage);
        reject(error);
      };
      ws.on("message", onMessage);
      ws.once("error", onError);
      ws.send("this is not json");
    });
    const response = await responsePromise;
    if (!isWebuiFrame(response)) throw new Error("expected frame");
    expect(response.kind).toBe("error");
    if (response.kind !== "error") throw new Error("expected error frame");
    expect(response.code).toBe(WebuiErrorCode.invalidEnvelope);
    ws.close();
  });

  it("shuts down in order: refuse operations, then close connections, then close the harness port", async () => {
    const { url } = await bootService();
    const { ws, upgrade } = openClient(url);
    await upgrade;
    const request = {
      protocolVersion: WEBUI_PROTOCOL_VERSION,
      kind: "request",
      requestId: "req-before-shutdown",
      operation: "version",
      body: undefined,
    };
    const response = await requestOnce(ws, request);
    if (!isWebuiFrame(response) || response.kind !== "response")
      throw new Error("version query should have answered before shutdown");

    const closePromise = service.close();
    const closeObserved = awaitClose(ws);
    const [info] = await Promise.all([closeObserved, closePromise]);
    expect(info.code).toBeGreaterThanOrEqual(1000);
    expect(port.closed).toBe(true);
    // A second close is a no-op (the first already refused new operations).
    await service.close();
  });

  it("does not accept requests after shutdown has been requested", async () => {
    const { url } = await bootService();
    const { ws, upgrade } = openClient(url);
    await upgrade;
    // Drive the shutdown and assert the in-flight connection is closed.
    await service.close();
    const closeEvent = await awaitClose(ws);
    expect(closeEvent.code).toBeGreaterThanOrEqual(1000);
    expect(port.closed).toBe(true);
  });

  it("forwards global runtime events on a connection-scoped watcher", async () => {
    const { url } = await bootService();
    const { ws, upgrade } = openClient(url);
    await upgrade;
    const event = new Promise<Record<string, unknown>>((resolve, reject) => {
      const onMessage = (raw: RawData) => {
        try {
          const frame = JSON.parse(raw.toString("utf8")) as Record<
            string,
            unknown
          >;
          if (frame.kind === "event") {
            ws.off("error", onError);
            resolve(frame);
          }
        } catch (error) {
          reject(error);
        }
      };
      const onError = (error: Error) => {
        ws.off("message", onMessage);
        reject(error);
      };
      ws.on("message", onMessage);
      ws.once("error", onError);
    });
    ws.send(
      JSON.stringify({
        protocolVersion: WEBUI_PROTOCOL_VERSION,
        kind: "request",
        requestId: "watch-events",
        operation: "watchEvents",
      }),
    );
    const frame = await event;
    expect(frame.requestId).toBe("watch-events");
    expect(frame.body).toMatchObject({ type: "session.start", source: "test" });
    ws.close();
  });

  it("routes permission and questionnaire answers to the running harness turn", async () => {
    const { url } = await bootService();
    const { ws, upgrade } = openClient(url);
    await upgrade;

    await requestOnce(ws, {
      protocolVersion: WEBUI_PROTOCOL_VERSION,
      kind: "request",
      requestId: "reply-permission",
      operation: "replyPermission",
      body: {
        name: "main",
        requestId: "permission-1",
        reply: "allowOnce",
      },
    });
    await requestOnce(ws, {
      protocolVersion: WEBUI_PROTOCOL_VERSION,
      kind: "request",
      requestId: "reply-questionnaire",
      operation: "replyQuestionnaire",
      body: {
        name: "main",
        requestId: "questionnaire-1",
        schemaVersion: 1,
        answers: [
          {
            stepId: "purpose",
            selectedOptionIds: [],
            selectedOther: true,
            otherText: "Keep the current behavior",
          },
        ],
      },
    });
    await requestOnce(ws, {
      protocolVersion: WEBUI_PROTOCOL_VERSION,
      kind: "request",
      requestId: "dismiss-questionnaire",
      operation: "dismissQuestionnaire",
      body: { name: "main", requestId: "questionnaire-1" },
    });

    expect(port.lastPermissionReply).toEqual({
      name: "main",
      requestId: "permission-1",
      reply: "allowOnce",
    });
    expect(port.lastQuestionnaireReply).toEqual({
      name: "main",
      requestId: "questionnaire-1",
      schemaVersion: 1,
      answers: [
        {
          stepId: "purpose",
          selectedOptionIds: [],
          selectedOther: true,
          otherText: "Keep the current behavior",
        },
      ],
    });
    expect(port.lastQuestionnaireDismissal).toEqual({
      name: "main",
      requestId: "questionnaire-1",
    });
    ws.close();
  });

  it("keeps two tab subscriptions independent when one tab closes", async () => {
    const { url } = await bootService();
    const first = openClient(url);
    const second = openClient(url);
    await Promise.all([first.upgrade, second.upgrade]);

    const watch = (ws: WebSocket, requestId: string) => {
      const event = new Promise<Record<string, unknown>>((resolve, reject) => {
        const onMessage = (raw: RawData) => {
          try {
            const frame = JSON.parse(raw.toString("utf8")) as Record<
              string,
              unknown
            >;
            if (frame.requestId === requestId && frame.kind === "event") {
              ws.off("error", onError);
              resolve(frame);
            }
          } catch (error) {
            reject(error);
          }
        };
        const onError = (error: Error) => {
          ws.off("message", onMessage);
          reject(error);
        };
        ws.on("message", onMessage);
        ws.once("error", onError);
      });
      ws.send(
        JSON.stringify({
          protocolVersion: WEBUI_PROTOCOL_VERSION,
          kind: "request",
          requestId,
          operation: "watchEvents",
          body: {},
        }),
      );
      return event;
    };

    const [firstEvent, secondEvent] = await Promise.all([
      watch(first.ws, "watch-first"),
      watch(second.ws, "watch-second"),
    ]);
    expect(firstEvent).toMatchObject({
      requestId: "watch-first",
      body: { type: "session.start", payload: { sessionId: "fixture-session" } },
    });
    expect(secondEvent).toMatchObject({
      requestId: "watch-second",
      body: { type: "session.start", payload: { sessionId: "fixture-session" } },
    });

    first.ws.close();
    await first.closed;
    const response = await requestOnce(second.ws, {
      protocolVersion: WEBUI_PROTOCOL_VERSION,
      kind: "request",
      requestId: "version-after-first-tab-close",
      operation: "version",
      body: undefined,
    });
    expect(response).toMatchObject({
      kind: "response",
      requestId: "version-after-first-tab-close",
    });
    second.ws.close();
  });
});

describe("WebUI workspace directory browsing", () => {
  // A browser cannot hand the WebUI an absolute path: the File System Access
  // API returns a bare directory name and `File.path` exists only inside
  // Electron. The server therefore enumerates the candidates the picker
  // offers, and every path it reports has to satisfy the same rule
  // createSession enforces.
  async function withTempTree(
    run: (root: string) => Promise<void>,
  ): Promise<void> {
    const root = await mkdtemp(path.join(os.tmpdir(), "webui-workspace-dirs-"));
    try {
      await mkdir(path.join(root, "beta"));
      await mkdir(path.join(root, "Alpha"));
      await mkdir(path.join(root, ".hidden"));
      await writeFile(path.join(root, "notes.md"), "synthetic\n");
      await run(root);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }

  it("lists only directories, hides dot-directories, and reports an absolute parent", async () => {
    const { listWorkspaceDirectories } = await import(
      "../../src/server/operation/workspace.js"
    );

    await withTempTree(async (root) => {
      const listing = listWorkspaceDirectories(root);

      expect(listing.dir).toBe(root);
      expect(listing.parent).toBe(path.dirname(root));
      expect(listing.entries.map((entry) => entry.name)).toEqual([
        "Alpha",
        "beta",
      ]);
      expect(listing.truncated).toBe(false);
      // The property that broke the picker: every candidate the server
      // offers is a path createSession will accept.
      expect(
        listing.entries.every((entry) => path.isAbsolute(entry.path)),
      ).toBe(true);
      expect(
        listing.entries.every((entry) => entry.path.startsWith(root)),
      ).toBe(true);
    });
  });

  it("has no parent to offer at the filesystem root", async () => {
    const { listWorkspaceDirectories } = await import(
      "../../src/server/operation/workspace.js"
    );
    const root = path.parse(path.resolve(os.tmpdir())).root;

    const listing = listWorkspaceDirectories(root);

    expect(listing.dir).toBe(root);
    expect(listing.parent).toBeUndefined();
  });

  it("starts at the server user's home directory when no directory is given", async () => {
    const { listWorkspaceDirectories } = await import(
      "../../src/server/operation/workspace.js"
    );

    expect(listWorkspaceDirectories().dir).toBe(os.homedir());
  });

  it("rejects relative, empty, missing and non-string directories", async () => {
    const { browseWorkspaceDirsOperation } = await import(
      "../../src/server/operation/workspace.js"
    );

    expect(browseWorkspaceDirsOperation.validate(undefined)).toEqual({
      ok: true,
      body: {},
    });
    expect(browseWorkspaceDirsOperation.validate({}).ok).toBe(true);
    expect(browseWorkspaceDirsOperation.validate({ dir: "  " }).ok).toBe(false);
    expect(
      browseWorkspaceDirsOperation.validate({ dir: "relative/dir" }).ok,
    ).toBe(false);
    expect(browseWorkspaceDirsOperation.validate({ dir: 42 }).ok).toBe(false);
    expect(
      browseWorkspaceDirsOperation.validate({
        dir: path.join(os.tmpdir(), "webui-not-a-real-directory"),
      }).ok,
    ).toBe(false);
    expect(
      browseWorkspaceDirsOperation.validate({
        dir: ` ${os.tmpdir()} `,
      }),
    ).toEqual({ ok: true, body: { dir: os.tmpdir() } });
  });

  it("serves an absolute listing through the operation registry", async () => {
    const { createOperationRegistry } = await import("../../src/server/index.js");
    const registry = createOperationRegistry(new ScriptedHarnessPort());

    const entry = registry.get("browseWorkspaceDirs");
    expect(entry).toBeDefined();

    await withTempTree(async (root) => {
      const result = (await entry!.handle(
        { requestId: "browse" },
        { dir: root },
      )) as { readonly body: { readonly dir: string } };

      expect(result.body.dir).toBe(root);
    });
  });
});

describe("WebUI operation allowlist", () => {
  it("routes all authoritative diff operations through the service registry", async () => {
    const { createOperationRegistry } = await import("../../src/server/index.js");
    const port = new ScriptedHarnessPort();
    const registry = createOperationRegistry(port);
    const request = { id: "session-1", assistantMessageId: "assistant-1", changeSetId: "changes-1" };
    const invoke = async (name: string, body: unknown) => {
      const entry = registry.get(name);
      if (!entry) throw new Error(`missing operation: ${name}`);
      return entry.handle({ requestId: name }, body);
    };
    expect(await invoke("getSessionDiff", { id: "session-1", messageId: "assistant-1" })).toMatchObject({ body: { changeSetId: "changes-1" } });
    expect(await invoke("getTurnDiff", request)).toMatchObject({ body: { status: "active" } });
    expect(await invoke("revertTurnDiff", request)).toMatchObject({ body: { turnDiff: { status: "reverted" } } });
    expect(await invoke("reapplyTurnDiff", request)).toMatchObject({ body: { status: "active" } });
    expect(port.diffRequests.map((entry) => entry.operation)).toEqual([
      "getSessionDiff",
      "getTurnDiff",
      "revertTurnDiff",
      "reapplyTurnDiff",
    ]);
  });

  it("enforces structural validation on every request body", async () => {
    const port = new ScriptedHarnessPort();
    const service = new WebuiService({ port });
    try {
      await service.start();
      // The transport already exercises this with the ws test; here we
      // exercise the operations module directly so the test stays in
      // scope for future operations without spinning up another server.
      const { createOperationRegistry } =
        await import("../../src/server/index.js");
      const registry = createOperationRegistry(port);
      expect(registry.has("version")).toBe(true);
      expect(registry.has("sendMessage")).toBe(true);
      expect(registry.has("enqueueMessage")).toBe(true);
      expect(registry.has("getSession")).toBe(true);
      expect(registry.has("getMessages")).toBe(true);
      expect(registry.has("getWorkspaceEnvironment")).toBe(true);
      expect(registry.has("mutateWorkspaceGit")).toBe(true);
      // resumeSession sits next to sendMessage in the allowlist because it
      // shares the same wire shape (the brief's "resume is not a second
      // transport"). It must be registered, validator-bound, and reachable
      // through the same `entry.handle(...)` plumbing.
      expect(registry.has("resumeSession")).toBe(true);
      expect(registry.has("watchEvents")).toBe(true);
      expect(registry.has("replyPermission")).toBe(true);
      expect(registry.has("abortSession")).toBe(true);
      expect(registry.has("listModels")).toBe(true);
      expect(registry.has("getAccountStatus")).toBe(true);
      for (const operation of [
        "archiveSession", "deleteSession", "updateSession", "getSessionForkOptions", "forkSession", "listUserModelProviders", "createUserModelProvider",
        "updateUserModelProvider", "deleteUserModelProvider", "testUserModelProvider", "testUserModel",
        "discoverUserModelsCandidate", "saveUserModelProviderCandidate", "listProviderPresets",
        "getMiniMaxApiKeyStatus", "upsertMiniMaxApiKey", "getCodexOAuthStatus",
        "getMiniMaxModelSource", "setMiniMaxModelSource", "testUserModelCandidate",
        "revealModelProviderApiKey", "startCodexOAuthLogin", "cancelCodexOAuthLogin", "refreshModels",
      ]) expect(registry.has(operation)).toBe(true);
    } finally {
      await service.close();
    }
  });

  it("routes provider reads and writes through the registry without exposing secrets", async () => {
    const { createOperationRegistry } = await import("../../src/server/index.js");
    const port = new ScriptedHarnessPort();
    const registry = createOperationRegistry(port);
    const result = async (name: string, body: unknown) => (await registry.get(name)?.handle({ requestId: name }, body)) as { readonly body: unknown };
    expect(await result("listUserModelProviders", undefined)).toMatchObject({ body: [{ providerId: "fixture-provider" }] });
    const createRequest = { providerId: "synthetic-provider", name: "Synthetic", baseUrl: "https://invalid.example", headers: { "X-First": "one", "X-Second": "two" } };
    expect(await result("createUserModelProvider", createRequest)).toMatchObject({ body: { success: true } });
    const toggleRequest = { providerId: "synthetic-provider", models: [{ modelId: "fixture-model", enabled: false }] };
    expect(await result("updateUserModelProvider", toggleRequest)).toMatchObject({ body: { success: true } });
    const reorderRequest = { providerId: "synthetic-provider", models: [{ modelId: "model-b" }, { modelId: "model-a" }] };
    expect(await result("updateUserModelProvider", reorderRequest)).toMatchObject({ body: { success: true } });
    expect(await result("deleteUserModelProvider", { providerId: "synthetic-provider" })).toMatchObject({ body: { success: true } });
    expect(await result("testUserModelProvider", { providerId: "fixture-provider", apiKey: "unsaved-key" })).toMatchObject({ body: { success: true } });
    expect(port.lastProviderTest).toEqual({ providerId: "fixture-provider", apiKey: "unsaved-key" });
    const modelTestRequest = { providerId: "fixture-provider", modelId: "fixture-model" };
    expect(await result("testUserModel", modelTestRequest)).toMatchObject({ body: { success: true } });
    expect(port.lastModelTest).toEqual(modelTestRequest);
    const discoverRequest = { providerId: "synthetic-provider", expectedRevision: "rev-1", baseUrl: "https://invalid.example" };
    expect(await result("discoverUserModelsCandidate", discoverRequest)).toMatchObject({ body: [{ modelId: "discovered-model" }] });
    const candidate = { providerId: "synthetic-provider", expectedRevision: "rev-1", name: "Synthetic", baseUrl: "https://invalid.example", apiKey: "unsaved-secret", headers: { "X-First": "one", "X-Second": "two" }, models: [{ modelId: "fixture-model" }] };
    const candidateTestRequest = { candidate, modelId: "fixture-model" };
    expect(await result("testUserModelCandidate", candidateTestRequest)).toMatchObject({ body: { success: true } });
    const saveRequest = { candidate, modelId: "fixture-model", saveAndUse: false, skipConnectionTest: false };
    expect(await result("saveUserModelProviderCandidate", saveRequest)).toMatchObject({ body: { success: true } });
    expect(port.providerMutations).toEqual([
      { operation: "create", request: createRequest },
      { operation: "update", request: toggleRequest },
      { operation: "update", request: reorderRequest },
      { operation: "delete", request: "synthetic-provider" },
      { operation: "discover", request: discoverRequest },
      { operation: "test-candidate", request: candidateTestRequest },
      { operation: "save-candidate", request: saveRequest },
    ]);
    expect(await result("listProviderPresets", undefined)).toMatchObject({ body: [] });
    expect(await result("getMiniMaxApiKeyStatus", undefined)).toMatchObject({ body: { hasApiKey: false } });
    expect(await result("getCodexOAuthStatus", undefined)).toMatchObject({ body: { connected: false } });
    expect(await result("getMiniMaxModelSource", undefined)).toMatchObject({ body: "token_plan" });
    expect(await result("setMiniMaxModelSource", { source: "minimax_api_key" })).toMatchObject({ body: "minimax_api_key" });
    expect(await result("refreshModels", undefined)).toMatchObject({ body: { models: [] } });
  });

  it("routes workspace environment reads and git mutations through the registry", async () => {
    const { createOperationRegistry } = await import("../../src/server/index.js");
    const registry = createOperationRegistry(new ScriptedHarnessPort());
    const result = async (name: string, body: unknown) => (await registry.get(name)?.handle({ requestId: name }, body)) as { readonly body: unknown };
    expect(await result("getWorkspaceEnvironment", { workspaceDir: "/tmp/project" })).toMatchObject({ body: { isGitRepo: true, branch: "fixture", changedFiles: 1 } });
    expect(await result("mutateWorkspaceGit", { workspaceDir: "/tmp/project", action: "commit", message: "fixture" })).toMatchObject({ body: { success: true } });
  });
});

describe("WebUI host factory", () => {
  it("is a thin adapter over the harness layer's host", async () => {
    const { createHarnessPortFromHost } =
      await import("../../src/runtime/index.js");
    const apiHost = {
      closeCalls: 0,
      async close(): Promise<void> {
        this.closeCalls += 1;
      },
    };
    const fakeHost = {
      apiHost,
      dataDir: "/tmp/data",
      appVersion: "1.2.3",
    };
    const harness = createHarnessPortFromHost(fakeHost);
    expect(harness.version().version).toBe("1.2.3");
    await harness.close();
    expect(apiHost.closeCalls).toBe(1);
    // Idempotent close: a second call does not re-close the host.
    await harness.close();
    expect(apiHost.closeCalls).toBe(1);
  });
});

describe("WebUI runtime host assembly", () => {
  it("creates exactly one host per process with the assembly step 6 owner combination", async () => {
    const { createWebuiRuntimeHost } =
      await import("../../src/runtime/index.js");
    const dataDir = await mkdtemp(path.join(os.tmpdir(), "webui-assembly-c1-"));
    let calls = 0;
    let lastOptions: Record<string, unknown> | undefined;
    try {
      const assembled = await createWebuiRuntimeHost({
        dataDir,
        appVersion: "0.4.2-assembly-test",
        factory: async (options) => {
          calls += 1;
          lastOptions = { ...options };
          return {
            apiHost: { close: async () => undefined },
            dataDir: options.dataDir,
            appVersion: "0.4.2-assembly-test",
          };
        },
      });
      await assembled.harnessPort.close();
      expect(calls).toBe(1);
      expect(lastOptions?.runtimeOwnerKind).toBe("webui");
      // The `webui` policy row accounts for the capability ceiling directly,
      // so the assembly no longer borrows the terminal client's
      // `capabilityProfile: "cli"`. Reintroducing it would silently re-grant
      // what the row deliberately withholds.
      expect(lastOptions && "capabilityProfile" in lastOptions).toBe(false);
      expect(lastOptions?.runtimeMode).toBe("clean");
      expect(lastOptions?.startupExecutionPolicy).toBe("quarantined");
      expect(lastOptions?.dataDir).toBe(dataDir);
      expect(lastOptions?.appVersion).toBe("0.4.2-assembly-test");
      const capabilities = lastOptions?.capabilities as Record<string, unknown>;
      expect(capabilities.cliEmbedded).toBe(true);
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it("exposes the usage quota client on both the host and the harness port", async () => {
    // `scripts/run-webui-server.mjs` builds the service port from
    // `assembled.host`, not from `assembled.harnessPort` — if the quota
    // client lives only on the harness port, the live panel fails with
    // "runtime host does not expose the usage quota client".
    const { createWebuiRuntimeHost } =
      await import("../../src/runtime/index.js");
    const dataDir = await mkdtemp(
      path.join(os.tmpdir(), "webui-assembly-quota-"),
    );
    try {
      const assembled = await createWebuiRuntimeHost({
        dataDir,
        appVersion: "0.4.2-assembly-test",
        factory: async (options) => ({
          apiHost: { close: async () => undefined },
          dataDir: options.dataDir,
          appVersion: "0.4.2-assembly-test",
        }),
      });
      expect(assembled.host.getUsageQuota).toBeTypeOf("function");
      expect(assembled.harnessPort.getUsageQuota).toBeTypeOf("function");
      expect(assembled.host.getSigninPanel).toBeTypeOf("function");
      expect(assembled.host.claimSignin).toBeTypeOf("function");
      expect(assembled.harnessPort.getSigninPanel).toBeTypeOf("function");
      expect(assembled.harnessPort.claimSignin).toBeTypeOf("function");
      await assembled.harnessPort.close();
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it("hands the runtime an auth context getter and invalidator for managed login", async () => {
    // Assembly step 3 of `docs/webui-v1-scope.md`. Managed MiniMax login has no
    // API key, so without this pair the resolver throws "managed OAuth bearer is
    // not synced" and every turn dies at the agent preflight — even with the
    // credential sitting in the data directory.
    const { createWebuiRuntimeHost } =
      await import("../../src/runtime/index.js");
    const dataDir = await mkdtemp(
      path.join(os.tmpdir(), "webui-assembly-auth-"),
    );
    const scopeDirectory = path.join(dataDir, "cli-auth", "prod", "cn");
    let lastOptions: Record<string, unknown> | undefined;
    try {
      await mkdir(scopeDirectory, { recursive: true });
      await writeFile(
        path.join(scopeDirectory, "cli-auth.scope.json"),
        `${JSON.stringify({ version: 1, updatedAtMs: 1, region: "cn", buildEnv: "prod" })}\n`,
        "utf8",
      );
      await writeFile(
        path.join(scopeDirectory, "local-runtime.auth.json"),
        `${JSON.stringify({
          version: 1,
          updatedAtMs: 1,
          auth: { accessToken: "assembled-token", realUserID: "user-1" },
        })}\n`,
        "utf8",
      );

      const assembled = await createWebuiRuntimeHost({
        dataDir,
        factory: async (options) => {
          lastOptions = { ...options };
          return { apiHost: { close: async () => undefined }, dataDir };
        },
      });
      await assembled.harnessPort.close();

      const getter = lastOptions?.authContextGetter as
        (() => { accessToken?: string } | undefined) | undefined;
      const invalidator = lastOptions?.authContextInvalidator as
        ((rejectedAccessToken?: string) => void) | undefined;
      expect(typeof getter).toBe("function");
      expect(typeof invalidator).toBe("function");
      expect(getter?.()?.accessToken).toBe("assembled-token");
      // A token the runtime rejected is not handed back a second time.
      invalidator?.("assembled-token");
      expect(getter?.()).toBeUndefined();
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it("declares the three interaction capabilities explicitly (criterion 2)", async () => {
    const { createWebuiRuntimeHost } =
      await import("../../src/runtime/index.js");
    const dataDir = await mkdtemp(path.join(os.tmpdir(), "webui-assembly-c2-"));
    let lastOptions: Record<string, unknown> | undefined;
    try {
      const assembled = await createWebuiRuntimeHost({
        dataDir,
        factory: async (options) => {
          lastOptions = { ...options };
          return {
            apiHost: { close: async () => undefined },
            dataDir: options.dataDir,
          };
        },
      });
      await assembled.harnessPort.close();
      const capabilities = lastOptions?.capabilities as Record<string, unknown>;
      // Mirror `packages/tui/src/runtime/lifecycle.ts:451-455`: the WebUI
      // is the surface that answers questionnaire, permission and
      // elicitation, so all three are true here.
      expect(capabilities.questionnaireReply).toBe(true);
      expect(capabilities.permissionPrompt).toBe(true);
      expect(capabilities.elicitation).toBe(true);
      expect(lastOptions?.enableLiveMcp).toBe(true);
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it("does not add a 'webui' value to surface (ADR 0004)", async () => {
    const { createWebuiRuntimeHost } =
      await import("../../src/runtime/index.js");
    const dataDir = await mkdtemp(
      path.join(os.tmpdir(), "webui-assembly-surface-"),
    );
    let lastOptions: Record<string, unknown> | undefined;
    try {
      const assembled = await createWebuiRuntimeHost({
        dataDir,
        factory: async (options) => {
          lastOptions = { ...options };
          return {
            apiHost: { close: async () => undefined },
            dataDir: options.dataDir,
          };
        },
      });
      await assembled.harnessPort.close();
      // The assembly intentionally omits `surface`; ADR 0004 forbids
      // extending the `surface` enum, and assembly step 4 says the WebUI
      // does not need a new value because `runtimeOwnerKind: 'webui'` plus
      // the capabilities already identify the surface.
      expect("surface" in (lastOptions ?? {})).toBe(false);
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it("wires the assembled host through the harness port that WebuiService tears down last", async () => {
    const { createWebuiRuntimeHost } =
      await import("../../src/runtime/index.js");
    const dataDir = await mkdtemp(
      path.join(os.tmpdir(), "webui-assembly-port-"),
    );
    let apiHostClosed = false;
    try {
      const assembled = await createWebuiRuntimeHost({
        dataDir,
        factory: async (options) => ({
          apiHost: {
            async close(): Promise<void> {
              apiHostClosed = true;
            },
          },
          dataDir: options.dataDir,
        }),
      });
      expect(assembled.harnessPort.close).toBeTypeOf("function");
      expect(assembled.harnessPort.version).toBeTypeOf("function");
      await assembled.harnessPort.close();
      expect(apiHostClosed).toBe(true);
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it("assembles tool capabilities explicitly and releases both owners on shutdown", async () => {
    const { createWebuiRuntimeHost } =
      await import("../../src/runtime/index.js");
    const dataDir = await mkdtemp(
      path.join(os.tmpdir(), "webui-assembly-tools-"),
    );
    const calls: string[] = [];
    let forwarded: Record<string, unknown> | undefined;
    const browserAdapter = {
      async execute(): Promise<unknown> {
        return { success: true, url: "https://example.test" };
      },
    };
    try {
      const assembled = await createWebuiRuntimeHost({
        dataDir,
        mcodeToolsRequested: true,
        browserToolExposure: "both",
        browserProvider: {
          adapter: browserAdapter,
          close: () => {
            calls.push("browser");
          },
        },
        mcodeTools: {
          prepare: async () => ({
            requested: true,
            ready: true,
            category: "ready" as const,
            ensureCommandPath: () => calls.push("command-path"),
            dispose: async () => {
              calls.push("broker");
            },
          }),
        },
        factory: async (options) => {
          forwarded = { ...options };
          return {
            apiHost: {
              close: async () => {
                calls.push("runtime");
              },
            },
            dataDir: options.dataDir,
          };
        },
      });
      const config = (
        forwarded?.configGetter as () => {
          beta?: Record<string, unknown>;
        }
      )();
      expect(config.beta?.mcodeTools).toBe(true);
      expect(config.beta?.browserUseTooling).toBe(true);
      expect(forwarded?.browserAdapter).toBe(browserAdapter);
      expect(forwarded?.browserToolExposure).toBe("both");
      expect(calls).toContain("command-path");
      await assembled.harnessPort.close();
      expect(calls).toEqual(["command-path", "runtime", "broker", "browser"]);
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it("reads a newly persisted default model through the live runtime config getter", async () => {
    const { createWebuiRuntimeHost } =
      await import("../../src/runtime/index.js");
    const dataDir = await mkdtemp(
      path.join(os.tmpdir(), "webui-assembly-model-config-") ,
    );
    let readConfig: (() => { readonly defaultModel?: string }) | undefined;
    try {
      vi.stubEnv("MINIMAX_DATA_DIR", dataDir);
      vi.stubEnv("DISABLE_GIT_AUTO_CONFIG", "1");
      await writeFile(
        path.join(dataDir, "config.yaml"),
        "defaultModel: minimax/MiniMax-M2.7\n",
        "utf8",
      );
      resetDefaultLocalRuntimeConfig();
      const assembled = await createWebuiRuntimeHost({
        dataDir,
        factory: async (options) => {
          readConfig = options.configGetter;
          return {
            apiHost: { close: async () => undefined },
            dataDir: options.dataDir,
          };
        },
      });

      expect(readConfig?.().defaultModel).toBe("minimax/MiniMax-M2.7");
      await updateLocalModelSelection({
        modelKey: "minimax/MiniMax-M3",
        variant: "thinking",
        contextLimit: 512_000,
      });
      expect(readConfig?.().defaultModel).toBe("minimax/MiniMax-M3");

      await assembled.harnessPort.close();
    } finally {
      resetDefaultLocalRuntimeConfig();
      vi.unstubAllEnvs();
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it("releases capability owners when host creation fails", async () => {
    const { createWebuiRuntimeHost } =
      await import("../../src/runtime/index.js");
    const dataDir = await mkdtemp(
      path.join(os.tmpdir(), "webui-assembly-startup-failure-"),
    );
    const calls: string[] = [];
    try {
      await expect(
        createWebuiRuntimeHost({
          dataDir,
          browserProvider: {
            adapter: {
              async execute(): Promise<unknown> {
                return undefined;
              },
            },
            close: () => {
              calls.push("browser");
            },
          },
          mcodeToolsRequested: true,
          mcodeTools: {
            prepare: async () => ({
              requested: true,
              ready: true,
              category: "ready" as const,
              ensureCommandPath: () => undefined,
              dispose: async () => {
                calls.push("broker");
              },
            }),
          },
          factory: async () => {
            throw new Error("host creation failed");
          },
        }),
      ).rejects.toThrow("host creation failed");
      expect(calls).toEqual(["broker", "browser"]);
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it("closes the partially created host when command-path setup fails", async () => {
    const { createWebuiRuntimeHost } =
      await import("../../src/runtime/index.js");
    const dataDir = await mkdtemp(
      path.join(os.tmpdir(), "webui-assembly-command-failure-"),
    );
    const calls: string[] = [];
    try {
      await expect(
        createWebuiRuntimeHost({
          dataDir,
          browserProvider: {
            adapter: {
              async execute(): Promise<unknown> {
                return undefined;
              },
            },
            close: () => {
              calls.push("browser");
            },
          },
          mcodeToolsRequested: true,
          mcodeTools: {
            prepare: async () => ({
              requested: true,
              ready: true,
              category: "ready" as const,
              ensureCommandPath: () => {
                throw new Error("command path failed");
              },
              dispose: async () => {
                calls.push("broker");
              },
            }),
          },
          factory: async (options) => ({
            apiHost: {
              close: async () => {
                calls.push("runtime");
              },
            },
            dataDir: options.dataDir,
          }),
        }),
      ).rejects.toThrow("command path failed");
      expect(calls).toEqual(["runtime", "broker", "browser"]);
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });
});

describe("WebUI loopback binding invariant", () => {
  it("refuses to construct the service when the host is a LAN address", async () => {
    const harness = new ScriptedHarnessPort();
    expect(() => new WebuiService({ port: harness, host: "0.0.0.0" })).toThrow(
      /loopback/i,
    );
    expect(() => new WebuiService({ port: harness, host: "10.0.0.5" })).toThrow(
      /loopback/i,
    );
    expect(
      () => new WebuiService({ port: harness, host: "evil.example" }),
    ).toThrow(/loopback/i);
  });

  it("accepts the documented loopback addresses", async () => {
    const harness = new ScriptedHarnessPort();
    for (const host of ["127.0.0.1", "localhost", "::1", "[::1]"]) {
      const candidate = new WebuiService({ port: harness, host });
      await candidate.close();
    }
  });
});

describe("WebUI operation body validation", () => {
  it("rejects null and array bodies on the version operation (criterion 5)", async () => {
    const { versionOperation } = await import("../../src/server/index.js");
    const nullResult = versionOperation.validate(null);
    expect(nullResult.ok).toBe(false);
    if (nullResult.ok) throw new Error("null should not be accepted");
    expect(nullResult.code).toBe(WebuiErrorCode.invalidBody);

    const arrayResult = versionOperation.validate([]);
    expect(arrayResult.ok).toBe(false);
    if (arrayResult.ok) throw new Error("[] should not be accepted");
    expect(arrayResult.code).toBe(WebuiErrorCode.invalidBody);

    const objectResult = versionOperation.validate({});
    expect(objectResult.ok).toBe(false);
    if (objectResult.ok) throw new Error("{} should not be accepted");
    expect(objectResult.code).toBe(WebuiErrorCode.invalidBody);

    const stringResult = versionOperation.validate("not-a-body");
    expect(stringResult.ok).toBe(false);
    if (stringResult.ok) throw new Error("string should not be accepted");
    expect(stringResult.code).toBe(WebuiErrorCode.invalidBody);

    const undefinedResult = versionOperation.validate(undefined);
    expect(undefinedResult.ok).toBe(true);
    if (!undefinedResult.ok) throw new Error("undefined should be accepted");
    expect(undefinedResult.body).toBeUndefined();
  });

  it("refuses to register an operation without a body validator", async () => {
    const { registerOperation, versionOperation } =
      await import("../../src/server/index.js");
    const registry = new Map();
    // The runtime check inside `registerOperation` inspects
    // `typeof operation.validate`, so the fixture intentionally omits
    // the `validate` function and is forged with a double cast to
    // bypass the interface — this is the fixture under test, not a
    // way to silence the typecheck of the real port contract.
    const validatorlessOperation = {
      name: "noValidator",
    } as unknown as import("../../src/server/index.js").WebuiOperation<unknown>;
    expect(() =>
      registerOperation(registry, {
        operation: validatorlessOperation,
        handle: () => ({ body: undefined }),
      }),
    ).toThrow(/validator/i);
    expect(registry.size).toBe(0);

    // Sanity check: the real version operation still registers.
    registerOperation(registry, {
      operation: versionOperation,
      handle: () => ({ body: { version: "1", protocolVersion: 1 } }),
    });
    expect(registry.has("version")).toBe(true);
  });
});

describe("WebUI shutdown order (criterion 7)", () => {
  it("refuses new operations before closing connections, and closes connections before the harness port", async () => {
    // A recording port that logs the order in which the service calls
    // its lifecycle hooks. This is the assertion surface for step 13 of
    // the assembly checklist.
    const events: string[] = [];
    let resolveConnectionClosed!: () => void;
    const connectionClosedGate = new Promise<void>((resolve) => {
      resolveConnectionClosed = resolve;
    });
    const recordingPort: WebuiHarnessPort = {
      version() {
        return { version: "0.4.2-shutdown-test", protocolVersion: 1 };
      },
      async readWorkspaceArchive() {
        return { archivePath: "", entries: [], totalEntries: 0, truncated: false };
      },
      async extractWorkspaceArchive() {
        return { archivePath: "", destination: "", writtenFiles: 0 };
      },
      async listSessions() {
        return { sessions: [], hasMore: false };
      },
      async createSession() {
        return { sessionId: "shutdown" };
      },
      async getSession() {
        return { session: { sessionId: "shutdown" } };
      },
      async getActiveTurn() {
        return undefined;
      },
      async getMessages() {
        return { messages: [], hasMore: false };
      },
      async enqueueMessage() {
        return { itemId: "shutdown-queued", status: "queued", position: 1 };
      },
      // The remaining 38 members of `WebuiHarnessPort` are not exercised
      // by the shutdown ordering assertion; they are still required by
      // the contract and provided here as fully-typed stubs returning
      // safe defaults so a forgotten member surfaces as a compile error
      // rather than a runtime `undefined is not a function`.
      async getSessionTree() {
        return { sessions: [], hasMore: false };
      },
      // Throw rather than fabricate a transfer file. These ports record
      // shutdown ordering; a stub that answered with a plausible empty
      // transfer would let an assertion about export/import pass against
      // data this double made up.
      async exportSessionTransfer() {
        throw new Error("exportSessionTransfer is not scripted on this double");
      },
      async importSessionTransfer() {
        throw new Error("importSessionTransfer is not scripted on this double");
      },
      async archiveSession() {
        return { success: true };
      },
      async deleteSession() {
        return { success: true };
      },
      async updateSession() {
        return { session: { sessionId: "shutdown-fixture", title: "Recording fixture" } };
      },
      async getSessionForkOptions() {
        return { canFork: false, worktreeVisible: false, worktreeEligible: false };
      },
      async forkSession() {
        return { session: { sessionId: "shutdown-fixture" } };
      },
      async sendMessage() {
        return { ok: true as const, source: [] };
      },
      async resumeSession() {
        return { ok: true as const, source: [] };
      },
      async *watchEvents(): AsyncIterable<WebuiRuntimeEvent> {
        // empty — no events are emitted during this shutdown test
      },
      async listPendingPermissions() {
        return { requests: [] };
      },
      async getPendingQuestionnaire() {
        return {};
      },
      async replyPermission() {
        return { success: true };
      },
      async replyQuestionnaire() {
        return { ok: true };
      },
      async dismissQuestionnaire() {
        return { ok: true };
      },
      async abortSession() {
        return { success: true };
      },
      async listQueueMessages() {
        return { items: [], paused: false, pendingCount: 0 };
      },
      async deleteQueueItem() {
        return {};
      },
      async listModels() {
        return [];
      },
      async listSkills() {
        return { skills: [] };
      },
      async selectModel() {
        return { success: true };
      },
      async getSessionUsage() {
        return {};
      },
      async getAccountStatus() {
        return { available: true };
      },
      async listUserModelProviders() {
        return [];
      },
      async createUserModelProvider() {
        return {};
      },
      async updateUserModelProvider() {
        return { success: true };
      },
      async deleteUserModelProvider() {
        return { success: true };
      },
      async testUserModelProvider() {
        return { success: true, status: { state: "ok" } };
      },
      async testUserModel() {
        return { success: true, status: { state: "ok" } };
      },
      async discoverUserModelsCandidate() {
        return [];
      },
      async saveUserModelProviderCandidate() {
        return { success: true };
      },
      async listProviderPresets() {
        return [];
      },
      async getMiniMaxApiKeyStatus() {
        return { hasApiKey: false };
      },
      async upsertMiniMaxApiKey() {
        return { success: true };
      },
      async getCodexOAuthStatus() {
        return { connected: false };
      },
      async getMiniMaxModelSource() { return "token_plan" as const; },
      async setMiniMaxModelSource(request: { source: "token_plan" | "minimax_api_key" }) { return request.source; },
      async testUserModelCandidate() { return { success: true }; },
      async revealModelProviderApiKey() { return ""; },
      async startCodexOAuthLogin() { return { loginId: "fixture" }; },
      async cancelCodexOAuthLogin() { return { connected: false }; },
      async refreshModels() { return { models: [] }; },
      async requestCompaction() {
        return { success: true };
      },
      async getSessionDiff() {
        return {
          diffs: [],
          changeSetId: "recording",
        };
      },
      async getTurnDiff() {
        return {
          status: "active",
          canUndo: false,
          canReapply: false,
          changeSetId: "recording",
          fileChanges: [],
        };
      },
      async revertTurnDiff() {
        return {
          success: true,
          turnDiff: {
            status: "reverted",
            canUndo: false,
            canReapply: true,
            changeSetId: "recording",
            fileChanges: [],
          },
        };
      },
      async reapplyTurnDiff() {
        return {
          success: true,
          status: "active",
          canUndo: true,
          canReapply: false,
          changeSetId: "recording",
          fileChanges: [],
        };
      },
      async listWorkspaceFileTree() {
        return [];
      },
      async readWorkspaceFile() {
        return { type: "text" as const, content: "" };
      },
      async getWorkspaceEnvironment() {
        return {
          isGitRepo: false,
          changedFiles: 0,
          insertions: 0,
          deletions: 0,
          lineStatsStatus: "skipped" as const,
        };
      },
      async mutateWorkspaceGit() {
        return { success: true };
      },
      async getWorkspaceReviewSummary() {
        return { repositoryId: "shutdown", reviewSnapshotId: "shutdown", files: [], totals: { files: 0, additions: 0, deletions: 0 } };
      },
      async listWorkspaceReviewFileDiffs(request: { readonly reviewSnapshotId: string }) {
        return { reviewSnapshotId: request.reviewSnapshotId, diffs: [] };
      },
      async getWorkspaceReviewFileContent(request: { readonly reviewSnapshotId: string; readonly fileId: string; readonly side: "old" | "new" }) {
        return { reviewSnapshotId: request.reviewSnapshotId, fileId: request.fileId, path: "recording", side: request.side, type: "text" as const, content: "" };
      },
      async searchWorkspaceReviewDiffs(request: { readonly reviewSnapshotId: string; readonly pageIndex?: number; readonly pageSize?: number }) {
        return { reviewSnapshotId: request.reviewSnapshotId, matchedFiles: [], totalMatches: 0, totalMatchedFiles: 0, pageIndex: request.pageIndex ?? 0, pageSize: request.pageSize ?? 20, matchesBeforePage: 0, hasPreviousPage: false, hasNextPage: false };
      },
      async readCanvas() {
        return {
          schemaVersion: 1,
          canvasId: "recording",
          sessionId: "shutdown",
          changeSeq: 0,
          nodes: [],
          updatedAtMs: 0,
        };
      },
      async applyCanvas() {
        return {
          operationId: "recording",
          document: {
            schemaVersion: 1,
            canvasId: "recording",
            sessionId: "shutdown",
            changeSeq: 0,
            nodes: [],
            updatedAtMs: 0,
          },
        };
      },
      async clearGoal() {
        return { success: true };
      },
      async getSessionRewindPreview() {
        return { turns: [] };
      },
      async rewindSession() {
        return { rewound: false };
      },
      async editSessionMessage() {
        return { rewound: false };
      },
      async isGoalEnabled() {
        return { enabled: false };
      },
      async getGoal() {
        return undefined;
      },
      async createGoal() {
        return {
          goalId: "goal-recording",
          sessionId: "shutdown",
          objective: "recording",
          status: "active" as const,
          createdAt: 0,
          updatedAt: 0,
          tokensUsed: 0,
          turnsUsed: 0,
          timeUsedSeconds: 0,
          tokenBudget: null,
          statusReason: null,
        };
      },
      async patchGoal() {
        return {
          goalId: "goal-recording",
          sessionId: "shutdown",
          objective: "recording",
          status: "active" as const,
          createdAt: 0,
          updatedAt: 0,
          tokensUsed: 0,
          turnsUsed: 0,
          timeUsedSeconds: 0,
          tokenBudget: null,
          statusReason: null,
        };
      },
      async invalidateAuth() {},
      async getUsageQuota() {
        return { signedIn: false as const };
      },
      async getSigninPanel() {
        return { scene: 0, days: [] };
      },
      async claimSignin() {
        return {
          claim_id: "stub",
          claim_result: 2,
          day_no: 1,
          points: 0,
          expire_at_ms: 0,
          panel: { scene: 0, days: [] },
        };
      },
      async beginAccountLogin() {
        return { state: "idle" as const };
      },
      async getAccountLoginStatus() {
        return { state: "idle" as const };
      },
      async cancelAccountLogin() {
        return { ok: true as const };
      },
      async signOutAccount() {
        return { status: "anonymous", generation: 0 };
      },
      async close() {
        // The service awaits wsServer.close() and httpServer.close()
        // before calling port.close(), so by the time we land here the
        // transport is fully drained. Wait for the connection close
        // event to be observed before recording port.close so the
        // ordering assertion is deterministic.
        await connectionClosedGate;
        events.push("port.close");
      },
    };
    const localService = new WebuiService({ port: recordingPort });
    const localInfo = await localService.start();
    const url = `${localInfo.boundUrl}/?token=${encodeURIComponent(
      localInfo.credential.token,
    )}`;
    const { ws, upgrade } = openClient(url);
    await upgrade;
    // Send a successful request first so we know the registry was
    // accepting before shutdown started.
    const request = {
      protocolVersion: WEBUI_PROTOCOL_VERSION,
      kind: "request",
      requestId: "req-pre-shutdown",
      operation: "version",
      body: undefined,
    };
    const preShutdown = await requestOnce(ws, request);
    if (!isWebuiFrame(preShutdown) || preShutdown.kind !== "response")
      throw new Error("version query should have answered before shutdown");

    // The service's `close()` calls `terminate()` synchronously on
    // every connection, then awaits wsServer.close() (which itself
    // waits for the connections to be torn down), then httpServer.close(),
    // and finally `port.close()`. The connection's `close` event fires
    // before wsServer.close() resolves; capture it and unblock the
    // recording port.
    const connectionClosed = awaitClose(ws).then((closeEvent) => {
      events.push(`connection.terminate:${closeEvent.code}`);
      resolveConnectionClosed();
    });
    await localService.close();
    await connectionClosed;
    // `connection.terminate:*` must precede `port.close`: the service
    // refuses new work, drops connections, then tears down the host.
    const terminateIndex = events.findIndex((event) =>
      event.startsWith("connection.terminate:"),
    );
    const portIndex = events.indexOf("port.close");
    expect(terminateIndex).toBeGreaterThanOrEqual(0);
    expect(portIndex).toBeGreaterThan(terminateIndex);
  });

  it("does not execute any handler after `close()` flips `accepting`", async () => {
    // A port whose `close()` blocks on a gate. The recording version
    // method observes whether `version()` is called from the registry
    // after `close()` has flipped `accepting`; the registry only calls
    // `port.version()` from the `version` operation handler. The test
    // counts `version()` calls: baseline + zero post-shutdown.
    let releaseCloseGate!: () => void;
    const closeGate = new Promise<void>((resolve) => {
      releaseCloseGate = resolve;
    });
    let versionCalls = 0;
    const recordingPort: WebuiHarnessPort = {
      version() {
        versionCalls += 1;
        return { version: "0.4.2-shutdown-gate", protocolVersion: 1 };
      },
      async readWorkspaceArchive() {
        return { archivePath: "", entries: [], totalEntries: 0, truncated: false };
      },
      async extractWorkspaceArchive() {
        return { archivePath: "", destination: "", writtenFiles: 0 };
      },
      async listSessions() {
        return { sessions: [], hasMore: false };
      },
      async createSession() {
        return { sessionId: "shutdown" };
      },
      async getSession() {
        return { session: { sessionId: "shutdown" } };
      },
      async getActiveTurn() {
        return undefined;
      },
      async getMessages() {
        return { messages: [], hasMore: false };
      },
      async enqueueMessage() {
        return {
          itemId: "shutdown-gate-queued",
          status: "queued",
          position: 1,
        };
      },
      // The remaining 38 members of `WebuiHarnessPort` are not exercised
      // by the post-shutdown handler assertion; they are still required
      // by the contract and provided here as fully-typed stubs returning
      // safe defaults so a forgotten member surfaces as a compile error
      // rather than a runtime `undefined is not a function`.
      async getSessionTree() {
        return { sessions: [], hasMore: false };
      },
      // Throw rather than fabricate a transfer file. These ports record
      // shutdown ordering; a stub that answered with a plausible empty
      // transfer would let an assertion about export/import pass against
      // data this double made up.
      async exportSessionTransfer() {
        throw new Error("exportSessionTransfer is not scripted on this double");
      },
      async importSessionTransfer() {
        throw new Error("importSessionTransfer is not scripted on this double");
      },
      async archiveSession() {
        return { success: true };
      },
      async deleteSession() {
        return { success: true };
      },
      async updateSession() {
        return { session: { sessionId: "shutdown-fixture", title: "Recording fixture" } };
      },
      async getSessionForkOptions() {
        return { canFork: false, worktreeVisible: false, worktreeEligible: false };
      },
      async forkSession() {
        return { session: { sessionId: "shutdown-fixture" } };
      },
      async sendMessage() {
        return { ok: true as const, source: [] };
      },
      async resumeSession() {
        return { ok: true as const, source: [] };
      },
      async *watchEvents(): AsyncIterable<WebuiRuntimeEvent> {
        // empty — no events are emitted during this post-shutdown test
      },
      async listPendingPermissions() {
        return { requests: [] };
      },
      async getPendingQuestionnaire() {
        return {};
      },
      async replyPermission() {
        return { success: true };
      },
      async replyQuestionnaire() {
        return { ok: true };
      },
      async dismissQuestionnaire() {
        return { ok: true };
      },
      async abortSession() {
        return { success: true };
      },
      async listQueueMessages() {
        return { items: [], paused: false, pendingCount: 0 };
      },
      async deleteQueueItem() {
        return {};
      },
      async listModels() {
        return [];
      },
      async listSkills() {
        return { skills: [] };
      },
      async selectModel() {
        return { success: true };
      },
      async getSessionUsage() {
        return {};
      },
      async getAccountStatus() {
        return { available: true };
      },
      async listUserModelProviders() {
        return [];
      },
      async createUserModelProvider() {
        return {};
      },
      async updateUserModelProvider() {
        return { success: true };
      },
      async deleteUserModelProvider() {
        return { success: true };
      },
      async testUserModelProvider() {
        return { success: true, status: { state: "ok" } };
      },
      async testUserModel() {
        return { success: true, status: { state: "ok" } };
      },
      async discoverUserModelsCandidate() {
        return [];
      },
      async saveUserModelProviderCandidate() {
        return { success: true };
      },
      async listProviderPresets() {
        return [];
      },
      async getMiniMaxApiKeyStatus() {
        return { hasApiKey: false };
      },
      async upsertMiniMaxApiKey() {
        return { success: true };
      },
      async getCodexOAuthStatus() {
        return { connected: false };
      },
      async getMiniMaxModelSource() { return "token_plan" as const; },
      async setMiniMaxModelSource(request: { source: "token_plan" | "minimax_api_key" }) { return request.source; },
      async testUserModelCandidate() { return { success: true }; },
      async revealModelProviderApiKey() { return ""; },
      async startCodexOAuthLogin() { return { loginId: "fixture" }; },
      async cancelCodexOAuthLogin() { return { connected: false }; },
      async refreshModels() { return { models: [] }; },
      async requestCompaction() {
        return { success: true };
      },
      async getSessionDiff() {
        return {
          diffs: [],
          changeSetId: "recording",
        };
      },
      async getTurnDiff() {
        return {
          status: "active",
          canUndo: false,
          canReapply: false,
          changeSetId: "recording",
          fileChanges: [],
        };
      },
      async revertTurnDiff() {
        return {
          success: true,
          turnDiff: {
            status: "reverted",
            canUndo: false,
            canReapply: true,
            changeSetId: "recording",
            fileChanges: [],
          },
        };
      },
      async reapplyTurnDiff() {
        return {
          success: true,
          status: "active",
          canUndo: true,
          canReapply: false,
          changeSetId: "recording",
          fileChanges: [],
        };
      },
      async listWorkspaceFileTree() {
        return [];
      },
      async readWorkspaceFile() {
        return { type: "text" as const, content: "" };
      },
      async getWorkspaceEnvironment() {
        return {
          isGitRepo: false,
          changedFiles: 0,
          insertions: 0,
          deletions: 0,
          lineStatsStatus: "skipped" as const,
        };
      },
      async mutateWorkspaceGit() {
        return { success: true };
      },
      async getWorkspaceReviewSummary() {
        return { repositoryId: "shutdown", reviewSnapshotId: "shutdown", files: [], totals: { files: 0, additions: 0, deletions: 0 } };
      },
      async listWorkspaceReviewFileDiffs(request: { readonly reviewSnapshotId: string }) {
        return { reviewSnapshotId: request.reviewSnapshotId, diffs: [] };
      },
      async getWorkspaceReviewFileContent(request: { readonly reviewSnapshotId: string; readonly fileId: string; readonly side: "old" | "new" }) {
        return { reviewSnapshotId: request.reviewSnapshotId, fileId: request.fileId, path: "recording", side: request.side, type: "text" as const, content: "" };
      },
      async searchWorkspaceReviewDiffs(request: { readonly reviewSnapshotId: string; readonly pageIndex?: number; readonly pageSize?: number }) {
        return { reviewSnapshotId: request.reviewSnapshotId, matchedFiles: [], totalMatches: 0, totalMatchedFiles: 0, pageIndex: request.pageIndex ?? 0, pageSize: request.pageSize ?? 20, matchesBeforePage: 0, hasPreviousPage: false, hasNextPage: false };
      },
      async readCanvas() {
        return {
          schemaVersion: 1,
          canvasId: "recording",
          sessionId: "shutdown",
          changeSeq: 0,
          nodes: [],
          updatedAtMs: 0,
        };
      },
      async applyCanvas() {
        return {
          operationId: "recording",
          document: {
            schemaVersion: 1,
            canvasId: "recording",
            sessionId: "shutdown",
            changeSeq: 0,
            nodes: [],
            updatedAtMs: 0,
          },
        };
      },
      async clearGoal() {
        return { success: true };
      },
      async getSessionRewindPreview() {
        return { turns: [] };
      },
      async rewindSession() {
        return { rewound: false };
      },
      async editSessionMessage() {
        return { rewound: false };
      },
      async isGoalEnabled() {
        return { enabled: false };
      },
      async getGoal() {
        return undefined;
      },
      async createGoal() {
        return {
          goalId: "goal-recording",
          sessionId: "shutdown",
          objective: "recording",
          status: "active" as const,
          createdAt: 0,
          updatedAt: 0,
          tokensUsed: 0,
          turnsUsed: 0,
          timeUsedSeconds: 0,
          tokenBudget: null,
          statusReason: null,
        };
      },
      async patchGoal() {
        return {
          goalId: "goal-recording",
          sessionId: "shutdown",
          objective: "recording",
          status: "active" as const,
          createdAt: 0,
          updatedAt: 0,
          tokensUsed: 0,
          turnsUsed: 0,
          timeUsedSeconds: 0,
          tokenBudget: null,
          statusReason: null,
        };
      },
      async invalidateAuth() {},
      async getUsageQuota() {
        return { signedIn: false as const };
      },
      async getSigninPanel() {
        return { scene: 0, days: [] };
      },
      async claimSignin() {
        return {
          claim_id: "stub",
          claim_result: 2,
          day_no: 1,
          points: 0,
          expire_at_ms: 0,
          panel: { scene: 0, days: [] },
        };
      },

      async beginAccountLogin() {
        return { state: "idle" as const };
      },
      async getAccountLoginStatus() {
        return { state: "idle" as const };
      },
      async cancelAccountLogin() {
        return { ok: true as const };
      },
      async signOutAccount() {
        return { status: "anonymous", generation: 0 };
      },
      async close() {
        await closeGate;
      },
    };
    const localService = new WebuiService({ port: recordingPort });
    const localInfo = await localService.start();
    const url = `${localInfo.boundUrl}/?token=${encodeURIComponent(
      localInfo.credential.token,
    )}`;
    const { ws, upgrade } = openClient(url);
    await upgrade;
    // Baseline: registry answers one request, calls `port.version()`
    // exactly once.
    const baseline = await requestOnce(ws, {
      protocolVersion: WEBUI_PROTOCOL_VERSION,
      kind: "request",
      requestId: "req-baseline",
      operation: "version",
      body: undefined,
    });
    if (!isWebuiFrame(baseline) || baseline.kind !== "response")
      throw new Error("baseline request should have answered");
    const baselineCalls = versionCalls;

    // Flip `accepting` synchronously without awaiting the rest of
    // shutdown. The service's `close()` does this immediately so any
    // handler invocation after this point short-circuits with the
    // `shuttingDown` error frame.
    const closePromise = localService.close();
    // Yield a microtask so the synchronous parts of `close()` land.
    await Promise.resolve();

    // Capture the next frame the service writes. The service will
    // either refuse the in-flight request with `shuttingDown` (handler
    // ran with `accepting === false`) or the connection will be torn
    // down (handler did not run, the connection is gone). Either path
    // proves no further `port.version()` call.
    const nextFrame = new Promise<unknown>((resolve) => {
      const onMessage = (raw: RawData) => {
        ws.off("message", onMessage);
        resolve(JSON.parse(raw.toString("utf8")));
      };
      ws.on("message", onMessage);
    });
    const closed = awaitClose(ws);
    ws.send(
      JSON.stringify({
        protocolVersion: WEBUI_PROTOCOL_VERSION,
        kind: "request",
        requestId: "req-after-shutdown",
        operation: "version",
        body: undefined,
      }),
    );
    const result = await Promise.race([nextFrame, closed]);
    releaseCloseGate();
    await closePromise;
    // The crucial assertion: no operation handler ran after
    // `accepting === false`. Whether the service replied with a
    // `shuttingDown` error frame (handler short-circuited) or the
    // connection was torn down before the reply arrived (handler did
    // not even start), the version counter must not have advanced.
    expect(versionCalls).toBe(baselineCalls);
    // Distinguish between the frame outcome (the second request was
    // answered) and the close outcome (the connection died first). The
    // close event carries a numeric `code`; a frame carries a string
    // `code` in the WebUI envelope.
    if (typeof result === "object" && result && "kind" in result) {
      expect(isWebuiFrame(result)).toBe(true);
      if (!isWebuiFrame(result)) throw new Error("expected frame");
      expect(result.kind).toBe("error");
      if (result.kind !== "error") throw new Error("expected error frame");
      expect(result.code).toBe(WebuiErrorCode.shuttingDown);
    } else {
      // Close event outcome: handler was prevented from running.
      expect(result).toMatchObject({ code: expect.any(Number) });
    }
  });
});

describe("WebUI assembly unconditionally forwards the quarantined startup policy (criterion 8)", () => {
  // This test pins the seam the assembly actually controls: the value of
  // `startupExecutionPolicy` that `createWebuiRuntimeHost` hands to the
  // harness factory on every boot. It does NOT prove that the harness
  // refrains from executing persisted jobs — that contract lives behind
  // `isLocalRuntimeStartupExecutionEnabled(options.startupExecutionPolicy)`
  // in `packages/local-runtime-v2/src/runtime.ts:831`, which gates the
  // background-runtime boot. Pinning the forwarded value here is the
  // WebUI's part of that joint contract; coverage for the harness's
  // gating lives in `packages/local-runtime-v2`.
  it("sets startupExecutionPolicy to 'quarantined' on every boot, including a second boot against the same dataDir", async () => {
    const { createWebuiRuntimeHost } =
      await import("../../src/runtime/index.js");
    const dataDir = await mkdtemp(path.join(os.tmpdir(), "webui-c8-policy-"));
    const forwarded: Array<{ startupExecutionPolicy?: string }> = [];
    type FactoryOptions = {
      dataDir: string;
      startupExecutionPolicy?: string;
    };
    const stubFactory = async (options: FactoryOptions) => {
      forwarded.push({
        startupExecutionPolicy: options.startupExecutionPolicy,
      });
      return {
        apiHost: { close: async () => undefined },
        dataDir: options.dataDir,
      };
    };
    try {
      const first = await createWebuiRuntimeHost({
        dataDir,
        factory: stubFactory,
      });
      const second = await createWebuiRuntimeHost({
        dataDir,
        factory: stubFactory,
      });
      // Both boots forward the quarantined policy unconditionally. The
      // second boot here proves the value is not derived from "is there
      // state on disk?" but is the same constant the assembly applies to
      // any boot.
      expect(forwarded).toEqual([
        { startupExecutionPolicy: "quarantined" },
        { startupExecutionPolicy: "quarantined" },
      ]);
      expect(first.forwardedOptions.startupExecutionPolicy).toBe("quarantined");
      expect(second.forwardedOptions.startupExecutionPolicy).toBe(
        "quarantined",
      );
      await first.harnessPort.close();
      await second.harnessPort.close();
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });
});

// Avoid the unused-import lint when the test scope skips a scenario.
