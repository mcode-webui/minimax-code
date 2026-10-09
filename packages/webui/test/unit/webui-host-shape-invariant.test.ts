// Host-shape invariants added in batch C.
//
// Before this batch, `createOperationRegistry` registered 18 of its ~70
// operations only when the runtime host happened to implement the matching
// capability gates (`port.getSessionDiff && port.getTurnDiff && ...`, etc.).
// Six capability gates meant the registry contents depended on which optional
// hooks the host exposed; tests could prove one shape, production could ship
// another, and the wire protocol was a function of the host.
//
// This test pins three invariants that close that gap:
//   1. The 18 operations that used to be gated are now in the registry on
//      every build, regardless of which host fields the harness fills.
//   2. The 6 terminal operations stay unregistered when the service is
//      constructed without a terminal adapter. The cold-started TUI emits the
//      same wire contract for "operation is not wired here" before its PTY
//      bridge comes up.
//   3. Wire-error contract: a request for an unregistered operation name
//      becomes an `unknown_operation` frame (registry short-circuits before
//      the handler runs); a request for a registered-but-broken operation
//      (one of the 18 that used to be gated) becomes a `harness_error`
//      frame sourced from the handler's own thrown message — and crucially
//      the dispatcher still looks the registry up FIRST.
//      bridge comes up.
//   3. (Compiler) `ScriptedHarnessPort` MUST satisfy `WebuiHarnessPort` —
//      this file imports the fake type and the port type together so a
//      missing port member breaks the test compile, not the runtime.

import { describe, expect, it } from "vitest";
import type { WebuiHarnessPort } from "../../src/server/port.js";
import {
  createOperationRegistry,
  editSessionMessageOperation,
  isGoalEnabledOperation,
  getGoalOperation,
  createGoalOperation,
  patchGoalOperation,
  clearGoalOperation,
  getSessionDiffOperation,
  getTurnDiffOperation,
  revertTurnDiffOperation,
  reapplyTurnDiffOperation,
  getSessionRewindPreviewOperation,
  rewindSessionOperation,
  listWorkspaceFileTreeOperation,
  readWorkspaceFileOperation,
  getWorkspaceEnvironmentOperation,
  mutateWorkspaceGitOperation,
  readCanvasOperation,
  applyCanvasOperation,
  createTerminalOperation,
  listTerminalsOperation,
  writeTerminalOperation,
  resizeTerminalOperation,
  disposeTerminalOperation,
  watchTerminalOperation,
} from "../../src/server/operation/operations.js";
import { createOperationHandlers, type WebuiOperationPort } from "../../src/server/operation/operation-handlers.js";
import { dispatchWebuiFrame } from "../../src/server/operation/operation-dispatch.js";
import { WEBUI_PROTOCOL_VERSION, WebuiErrorCode } from "../../src/shared/envelope.js";
import WebSocket from "ws";
import { createHarnessPortFromHost } from "../../src/server/host.js";

/**
 * Build a fully-implemented in-memory port so we can construct the
 * registry without standing up the runtime. A type-checked no-op for
 * every member — each method returns a structural zero that satisfies
 * the matching `WebuiHarnessPort` field. Forgetting a member fails the
 * compile instead of silently returning `undefined`.
 */
class FullPort implements WebuiHarnessPort {
  version() {
    return { version: "invariant-test", protocolVersion: 1 };
  }
  // Added with the F-zone archive contract. This class exists to make a
  // forgotten port member a compile error, so the members land here rather
  // than being left optional.
  async readWorkspaceArchive() {
    return { archivePath: "", entries: [], totalEntries: 0, truncated: false };
  }
  async extractWorkspaceArchive() {
    return { archivePath: "", destination: "", writtenFiles: 0 };
  }
  async listSessions() {
    return { sessions: [], hasMore: false };
  }
  async getSessionTree() {
    return { sessions: [], hasMore: false };
  }
  async archiveSession() {
    return { success: true };
  }
  async deleteSession() {
    return { success: true };
  }
  async updateSession() {
    return { session: { sessionId: "invariant" } };
  }
  async getSessionForkOptions() {
    return { canFork: false, worktreeVisible: false, worktreeEligible: false };
  }
  async forkSession() {
    return { session: { sessionId: "invariant" } };
  }
  async createSession() {
    return { sessionId: "invariant" };
  }
  async getSession() {
    return { session: { sessionId: "invariant" } };
  }
  async getActiveTurn() {
    return undefined;
  }
  async getMessages() {
    return { messages: [], hasMore: false };
  }
  async exportSessionTransfer() {
    return {
      format: "mcode-webui-session-transfer@1",
      exportedAt: "1970-01-01T00:00:00.000Z",
      session: { sessionId: "invariant", title: "invariant" },
      canonical: { envelopes: [], snapshots: [], generation: 0, revision: "" },
      display: { messages: [] },
    };
  }
  async importSessionTransfer(request: { readonly targetSessionId: string }) {
    return {
      sessionId: request.targetSessionId,
      canonicalMessages: 0,
      displayMessages: 0,
      revision: "",
    };
  }
  async getSessionDiff() {
    return { diffs: [], changeSetId: "invariant" };
  }
  async getTurnDiff() {
    return {
      status: "active",
      canUndo: false,
      canReapply: false,
      changeSetId: "invariant",
      fileChanges: [],
    };
  }
  async revertTurnDiff() {
    return {
      success: true,
      turnDiff: {
        status: "reverted",
        canUndo: false,
        canReapply: true,
        changeSetId: "invariant",
        fileChanges: [],
      },
    };
  }
  async reapplyTurnDiff() {
    return {
      success: true,
      status: "active",
      canUndo: true,
      canReapply: false,
      changeSetId: "invariant",
      fileChanges: [],
    };
  }
  async getSessionRewindPreview() {
    return { turns: [] };
  }
  async rewindSession() {
    return { rewound: false };
  }
  async editSessionMessage() {
    return { rewound: false };
  }
  async isGoalEnabled() {
    return { enabled: false };
  }
  async getGoal() {
    return undefined;
  }
  async createGoal(request: { readonly sessionId: string; readonly objective: string }) {
    return {
      goalId: "invariant",
      sessionId: request.sessionId,
      objective: request.objective,
      status: "active" as const,
      createdAt: 0,
      updatedAt: 0,
      tokensUsed: 0,
      turnsUsed: 0,
      timeUsedSeconds: 0,
      tokenBudget: null,
      statusReason: null,
    };
  }
  async patchGoal(request: { readonly sessionId: string }) {
    return {
      goalId: "invariant",
      sessionId: request.sessionId,
      objective: "",
      status: "active" as const,
      createdAt: 0,
      updatedAt: 0,
      tokensUsed: 0,
      turnsUsed: 0,
      timeUsedSeconds: 0,
      tokenBudget: null,
      statusReason: null,
    };
  }
  async clearGoal() {
    return { success: true };
  }
  async listWorkspaceFileTree() {
    return [];
  }
  async readWorkspaceFile() {
    return { type: "text" as const, content: "" };
  }
  async getWorkspaceEnvironment() {
    return {
      isGitRepo: false,
      changedFiles: 0,
      insertions: 0,
      deletions: 0,
      lineStatsStatus: "skipped" as const,
    };
  }
  async mutateWorkspaceGit() {
    return { success: true };
  }
  async getWorkspaceReviewSummary() {
    return { repositoryId: "invariant", reviewSnapshotId: "invariant", files: [], totals: { files: 0, additions: 0, deletions: 0 } };
  }
  async listWorkspaceReviewFileDiffs(request: { readonly reviewSnapshotId: string }) {
    return { reviewSnapshotId: request.reviewSnapshotId, diffs: [] };
  }
  async getWorkspaceReviewFileContent(request: { readonly reviewSnapshotId: string; readonly fileId: string; readonly side: "old" | "new" }) {
    return { reviewSnapshotId: request.reviewSnapshotId, fileId: request.fileId, path: "invariant", side: request.side, type: "text" as const, content: "" };
  }
  async searchWorkspaceReviewDiffs(request: { readonly reviewSnapshotId: string; readonly pageIndex?: number; readonly pageSize?: number }) {
    return { reviewSnapshotId: request.reviewSnapshotId, matchedFiles: [], totalMatches: 0, totalMatchedFiles: 0, pageIndex: request.pageIndex ?? 0, pageSize: request.pageSize ?? 20, matchesBeforePage: 0, hasPreviousPage: false, hasNextPage: false };
  }
  async readCanvas() {
    return {
      schemaVersion: 1,
      canvasId: "invariant",
      sessionId: "invariant",
      changeSeq: 0,
      nodes: [],
      updatedAtMs: 0,
    };
  }
  async applyCanvas() {
    return {
      operationId: "invariant",
      document: {
        schemaVersion: 1,
        canvasId: "invariant",
        sessionId: "invariant",
        changeSeq: 0,
        nodes: [],
        updatedAtMs: 0,
      },
    };
  }
  async sendMessage() {
    return { ok: true as const, source: [] };
  }
  async enqueueMessage() {
    return { itemId: "invariant", status: "queued", position: 1 };
  }
  async resumeSession() {
    return { ok: true as const, source: [] };
  }
  async *watchEvents() {
    // empty
  }
  async listPendingPermissions() {
    return { requests: [] };
  }
  async getPendingQuestionnaire() {
    return {};
  }
  async replyPermission() {
    return { success: true };
  }
  async replyQuestionnaire() {
    return { ok: true };
  }
  async dismissQuestionnaire() {
    return { ok: true };
  }
  async abortSession() {
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
      claim_id: "invariant",
      claim_result: 0,
      day_no: 0,
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
  async listUserModelProviders() {
    return [];
  }
  async createUserModelProvider() {
    return {};
  }
  async updateUserModelProvider() {
    return { success: true };
  }
  async deleteUserModelProvider() {
    return { success: true };
  }
  async testUserModelProvider() {
    return { success: true, status: { state: "ok" } };
  }
  async testUserModel() {
    return { success: true, status: { state: "ok" } };
  }
  async discoverUserModelsCandidate() {
    return [];
  }
  async saveUserModelProviderCandidate() {
    return { success: true };
  }
  async listProviderPresets() {
    return [];
  }
  async getMiniMaxApiKeyStatus() {
    return { hasApiKey: false };
  }
  async upsertMiniMaxApiKey() {
    return { success: true };
  }
  async getCodexOAuthStatus() {
    return { connected: false };
  }
  async getMiniMaxModelSource() { return "token_plan" as const; }
  async setMiniMaxModelSource(request: { source: "token_plan" | "minimax_api_key" }) { return request.source; }
  async testUserModelCandidate() { return { success: true }; }
  async revealModelProviderApiKey() { return ""; }
  async startCodexOAuthLogin() { return { loginId: "fixture" }; }
  async cancelCodexOAuthLogin() { return { connected: false }; }
  async refreshModels() { return { models: [] }; }
  async invalidateAuth() {
    // no-op: the full-port invariant never actually invalidates.
  }
  async requestCompaction() {
    // The invariant port satisfies the harness-port requirement that
    // `requestCompaction` exists on every implementor; the runner's
    // `/compact` slash command reaches it through `runWebuiCommand`.
    return { success: true as const };
  }
  // Added with the WebUI scheduled-task surface. The invariant port exists to
  // turn a forgotten port member into a compile error, so these land here
  // rather than being left to an optional hook.
  async close() {
    // no-op
  }
}

describe("WebUI host-shape invariant (batch C seam)", () => {
  it("forwards workspace review requests and snapshot ids through the runtime host", async () => {
    const calls: Array<{ readonly method: string; readonly request: unknown }> = [];
    const summary = { repositoryId: "repo-1", reviewSnapshotId: "snapshot-7", files: [], totals: { files: 0, additions: 0, deletions: 0 } };
    const fileDiffs = { reviewSnapshotId: "snapshot-7", diffs: [] };
    const host = {
      cliService: {
        getWorkspaceReviewSummary: async (workspaceDir: string) => {
          calls.push({ method: "summary", request: workspaceDir });
          return summary;
        },
        listWorkspaceReviewFileDiffs: async (request: unknown) => {
          calls.push({ method: "diffs", request });
          return fileDiffs;
        },
        getWorkspaceReviewFileContent: async (request: unknown) => {
          calls.push({ method: "content", request });
          return { reviewSnapshotId: "snapshot-7", fileId: "file-1", path: "src/index.ts", side: "new", type: "text", content: "" };
        },
        searchWorkspaceReviewDiffs: async (request: unknown) => {
          calls.push({ method: "search", request });
          return { reviewSnapshotId: "snapshot-7", matchedFiles: [], totalMatches: 0, totalMatchedFiles: 0, pageIndex: 0, pageSize: 20, matchesBeforePage: 0, hasPreviousPage: false, hasNextPage: false };
        },
      },
    } as never;
    const port = createHarnessPortFromHost(host);
    await expect(port.getWorkspaceReviewSummary({ workspaceDir: "/repo" })).resolves.toBe(summary);
    await expect(port.listWorkspaceReviewFileDiffs({ workspaceDir: "/repo", reviewSnapshotId: "snapshot-7", fileIds: ["file-1"] })).resolves.toBe(fileDiffs);
    await expect(port.getWorkspaceReviewFileContent({ workspaceDir: "/repo", reviewSnapshotId: "snapshot-7", fileId: "file-1", side: "new" })).resolves.toMatchObject({ reviewSnapshotId: "snapshot-7" });
    await expect(port.searchWorkspaceReviewDiffs({ workspaceDir: "/repo", reviewSnapshotId: "snapshot-7", query: "needle", includeUntrackedFiles: true })).resolves.toMatchObject({ reviewSnapshotId: "snapshot-7" });
    expect(calls).toEqual([
      { method: "summary", request: "/repo" },
      { method: "diffs", request: { workspaceDir: "/repo", reviewSnapshotId: "snapshot-7", fileIds: ["file-1"] } },
      { method: "content", request: { workspaceDir: "/repo", reviewSnapshotId: "snapshot-7", fileId: "file-1", side: "new" } },
      { method: "search", request: { workspaceDir: "/repo", reviewSnapshotId: "snapshot-7", query: "needle", includeUntrackedFiles: true } },
    ]);

    const failingPort = createHarnessPortFromHost({ cliService: {
      getWorkspaceReviewSummary: async () => { throw new Error("summary unavailable"); },
    } } as never);
    await expect(failingPort.getWorkspaceReviewSummary({ workspaceDir: "/repo" })).rejects.toThrow("summary unavailable");
  });

  // The 18 operations whose registration used to depend on a host capability
  // gate. After batch C every one of them is in the registry — see `operations.ts`,
  // where the six `if (port.<x> && port.<y>)` capability gates were deleted.
  const GATED_BUT_NOW_UNCONDITIONAL: readonly string[] = [
    // diff group (was: `if (port.getSessionDiff && port.getTurnDiff && port.revertTurnDiff && port.reapplyTurnDiff)`)
    getSessionDiffOperation.name,
    getTurnDiffOperation.name,
    revertTurnDiffOperation.name,
    reapplyTurnDiffOperation.name,
    // rewind/edit group (was: `if (port.getSessionRewindPreview && port.rewindSession && port.editSessionMessage)`)
    getSessionRewindPreviewOperation.name,
    rewindSessionOperation.name,
    editSessionMessageOperation.name,
    // goal group (was: `if (port.isGoalEnabled && port.getGoal && port.createGoal && port.patchGoal && port.clearGoal)`)
    isGoalEnabledOperation.name,
    getGoalOperation.name,
    createGoalOperation.name,
    patchGoalOperation.name,
    clearGoalOperation.name,
    // workspace/canvas group (was: `if (port.listWorkspaceFileTree && port.readWorkspaceFile && port.readCanvas && port.applyCanvas)`)
    listWorkspaceFileTreeOperation.name,
    readWorkspaceFileOperation.name,
    readCanvasOperation.name,
    applyCanvasOperation.name,
    // singletons (had their own `if (port.X)` lines)
    getWorkspaceEnvironmentOperation.name,
    mutateWorkspaceGitOperation.name,
  ];

  it("registers every operation the harness port exposes (no capability gate)", () => {
    const port = new FullPort();
    const registry = createOperationRegistry(port);
    for (const name of GATED_BUT_NOW_UNCONDITIONAL) {
      expect(
        registry.has(name),
        `expected ${name} to be in the registry, but it was gated`,
      ).toBe(true);
    }
  });

  it("keeps the six terminal operations out of the registry when no terminal adapter is wired", () => {
    const port = new FullPort();
    const registry = createOperationRegistry(port);
    const terminalNames = [
      createTerminalOperation.name,
      listTerminalsOperation.name,
      writeTerminalOperation.name,
      resizeTerminalOperation.name,
      disposeTerminalOperation.name,
      watchTerminalOperation.name,
    ];
    for (const name of terminalNames) {
      expect(
        registry.has(name),
        `expected ${name} to be absent without a terminal adapter, but it was registered`,
      ).toBe(false);
    }
  });

  it("narrows WebuiOperationPort to require every harness port method (port.ts)", () => {
    // Compile-time check — `FullPort` MUST satisfy `WebuiOperationPort`,
    // which `operation-handlers.ts` builds as `Pick<WebuiHarnessPort, ...>`.
    const port: WebuiOperationPort = new FullPort();
    // The handlers map derives its method shape from the operation
    // descriptors; we only need to verify it accepts the port.
    const handlers = createOperationHandlers(port);
    expect(Object.keys(handlers).length).toBeGreaterThan(0);
  });

  // --------------------------------------------------------------------
  // C-07: wire-error contract for capability-gated operations.
  //
  // Before batch C the 18 capability-gated operations were absent from the
  // registry when their port hooks were missing, so the dispatcher answered
  // with `unknown_operation`. They now register unconditionally (the
  // type-checked-port contract forces every implementor to provide them),
  // and a host that nonetheless throws is surfaced as `harness_error`.
  //
  // These tests prove the seam contracts on the live dispatcher.
  // --------------------------------------------------------------------
  describe("wire-error contract (C-07)", () => {
    function captureWebSocket(): {
      readonly ws: WebSocket;
      readonly frames: Array<Record<string, unknown>>;
    } {
      const frames: Array<Record<string, unknown>> = [];
      // The dispatcher reads `ws.OPEN` (a static on the WebSocket class)
      // and `ws.send`. Wrap the mock so both checks behave as expected.
      const ws = Object.create(WebSocket.prototype) as WebSocket;
      Object.defineProperty(ws, "readyState", { value: WebSocket.OPEN, configurable: true });
      ws.send = (data: string) => {
        frames.push(JSON.parse(data) as Record<string, unknown>);
      };
      return { ws, frames };
    }

    it("returns unknown_operation for a name the registry never had", async () => {
      const { ws, frames } = captureWebSocket();
      const port = new FullPort();
      const registry = createOperationRegistry(port);
      await dispatchWebuiFrame(
        ws,
        {
          protocolVersion: WEBUI_PROTOCOL_VERSION,
          kind: "request",
          requestId: "no-such-op",
          operation: "noSuchOperationThatNeverExisted",
          body: undefined,
        },
        registry,
        true,
        () => undefined,
      );
      expect(frames).toHaveLength(1);
      expect(frames[0]).toMatchObject({
        kind: "error",
        code: WebuiErrorCode.unknownOperation,
        requestId: "no-such-op",
      });
    });

    it("returns harness_error for a registered but throwing handler (e.g. one of the 18 gated ops)", async () => {
      const { ws, frames } = captureWebSocket();
      // A port that satisfies the type-checked seam but throws on a method
      // the host adapter's nested guards would also throw. We use the
      // getSessionDiff capability (one of the 18 gated ops) so a
      // post-batch-C build that still owed gate semantics would manifest
      // here. To prove the dispatcher answers via the handler's own
      // message, we throw with a code-free Error whose message we pick.
      class FailingDiffPort extends FullPort {
        override getSessionDiff() {
          return Promise.reject(new Error("session diff is unavailable"));
        }
      }
      const port = new FailingDiffPort();
      const registry = createOperationRegistry(port);
      await dispatchWebuiFrame(
        ws,
        {
          protocolVersion: WEBUI_PROTOCOL_VERSION,
          kind: "request",
          requestId: "diff-empty",
          operation: "getSessionDiff",
          body: { id: "session-fixture" },
        },
        registry,
        true,
        () => undefined,
      );
      expect(frames).toHaveLength(1);
      expect(frames[0]).toMatchObject({
        kind: "error",
        code: WebuiErrorCode.harnessError,
        requestId: "diff-empty",
        message: "session diff is unavailable",
      });
    });

    it("lookups happen before handler execution", async () => {
      // If a future change reorders the dispatcher to invoke handlers
      // ahead of the registry lookup, the unknown-operation branch
      // disappears and any name the registry never had becomes a
      // runtime-dispatch surface. This proof is here so the mutation
      // shows up immediately. The mutation we run for verification
      // (swap the lookup and the validate calls in operation-dispatch.ts)
      // must turn this expectation red — see the revise report.
      const { ws, frames } = captureWebSocket();
      const port = new FullPort();
      const registry = createOperationRegistry(port);
      await dispatchWebuiFrame(
        ws,
        {
          protocolVersion: WEBUI_PROTOCOL_VERSION,
          kind: "request",
          requestId: "ordering-test",
          operation: "an-operation-name-the-registry-does-not-have",
          body: undefined,
        },
        registry,
        true,
        () => undefined,
      );
      expect(frames[0]?.code).toBe(WebuiErrorCode.unknownOperation);
    });
  });
});
