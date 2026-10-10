import type { WebuiClientMessageSender, WebuiClientSessionResumer } from "../contracts/execution-port.js";
import type { WebuiClientMessageLoader, WebuiClientMessagePage } from "../contracts/message-view.js";
import type { WebuiClientCreateSessionRequest, WebuiClientCreateSessionResult, WebuiClientSessionLoader, WebuiClientSessionTreeLoader } from "../contracts/session-port.js";
import type { WebuiClientSessionPage, WebuiClientSessionTreePage, WebuiClientProject } from "../contracts/session-view.js";
import type { WebuiTransport } from "../contracts/transport.js";
import type {
  WebuiInteractionReplyResult,
  WebuiPendingPermission,
  WebuiQuestionnaireAnswer,
  WebuiQuestionnaireRequest,
} from "../../shared/contracts/interactions.js";
import type {
  WebuiQueueItem,
  WebuiEnqueueMessageRequest,
  WebuiEnqueueMessageResult,
} from "../../shared/contracts/queue.js";
import type { WebuiModelEntry } from "../../shared/contracts/models.js";
import type {
  WebuiRuntimeEvent,
  WebuiStreamFrame,
} from "../../shared/contracts/stream.js";
import type { WebuiVersionInfo } from "../../shared/contracts/version.js";
import type { WebuiTerminalFrame } from "../../shared/contracts/terminal.js";
import type {
  WebuiGetSessionDiffRequest,
  WebuiGetSessionDiffResult,
  WebuiGetTurnDiffRequest,
  WebuiGetTurnDiffResult,
  WebuiRevertTurnDiffRequest,
  WebuiRevertTurnDiffResult,
  WebuiReapplyTurnDiffRequest,
  WebuiReapplyTurnDiffResult,
  WebuiGetSessionForkOptionsRequest,
  WebuiGetSessionForkOptionsResult,
  WebuiForkSessionRequest,
  WebuiForkSessionResult,
  WebuiGetSessionRewindPreviewRequest,
  WebuiGetSessionRewindPreviewResult,
  WebuiRewindSessionRequest,
  WebuiRewindSessionResult,
  WebuiEditSessionMessageRequest,
  WebuiEditSessionMessageResult,
} from "../../shared/contracts/session.js";
import type {
  WebuiGoal,
  WebuiGoalCreateRequest,
  WebuiGoalPatchRequest,
  WebuiGoalEnabledResult,
} from "../../shared/contracts/goal.js";
import {
  createWebuiEventChannel,
  type WebuiClientEventWatcher,
  type WebuiClientRuntimeEvent,
  type WebuiSocket,
} from "./event-channel.js";
export type { WebuiClientEventWatcher, WebuiClientRuntimeEvent, WebuiSocket };

type WireFrame = {
  readonly kind: string;
  readonly requestId: string;
  readonly body?: unknown;
  readonly message?: string;
};

export interface WebuiTransportOptions {
  readonly websocketUrl: string;
  readonly token: string;
  readonly webSocket?: new (url: string) => WebuiSocket;
  /** Deadline for unary operations that otherwise could remain pending on a half-open socket. */
  readonly requestTimeoutMs?: number;
}

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

function defaultWebSocket(): new (url: string) => WebuiSocket {
  return WebSocket as unknown as new (url: string) => WebuiSocket;
}

export function createWebuiTransport({
  websocketUrl: baseWebsocketUrl,
  token,
  webSocket = defaultWebSocket(),
  requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
}: WebuiTransportOptions): Required<WebuiTransport> {
  /* The `Required<WebuiTransport>` return type together with the
   * `satisfies Required<WebuiTransport>` clause on the literal below forces
   * the wire contract and the implementation to stay in lock-step: a
   * missing member, a typo'd key, or a signature drift on either side
   * breaks the build. The `Required` qualifier is scoped to this
   * implementation boundary; the `WebuiTransport` capability contract
   * consumed by components keeps its optional semantics. */

  const websocketUrl = () =>
    `${baseWebsocketUrl.replace(/\/$/u, "")}/?token=${encodeURIComponent(token)}`;

  function request<T>(operation: string, body: unknown): Promise<T> {
    return new Promise((resolve, reject) => {
      const ws = new webSocket(websocketUrl());
      const requestId = crypto.randomUUID();
      let settled = false;
      let timeout: ReturnType<typeof setTimeout>;
      const fail = (error: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        ws.close();
        reject(error);
      };
      timeout = setTimeout(
        () =>
          fail(
            new Error(
              `WebUI request timed out after ${requestTimeoutMs}ms (${operation})`,
            ),
          ),
        requestTimeoutMs,
      );
      ws.addEventListener("open", () =>
        ws.send(
          JSON.stringify({
            protocolVersion: 1,
            kind: "request",
            requestId,
            operation,
            body,
          }),
        ),
      );
      ws.addEventListener("message", (event) => {
        let frame: WireFrame;
        try {
          frame = JSON.parse(String(event.data)) as WireFrame;
        } catch {
          fail(new Error("WebUI returned invalid JSON"));
          return;
        }
        if (frame.requestId !== requestId) return;
        if (frame.kind === "error") {
          fail(new Error(frame.message ?? "WebUI request refused"));
          return;
        }
        if (frame.kind !== "response") return;
        settled = true;
        clearTimeout(timeout);
        ws.close();
        resolve(frame.body as T);
      });
      ws.addEventListener("close", () =>
        fail(new Error("WebUI connection closed before the response")),
      );
      ws.addEventListener("error", () =>
        fail(new Error("WebUI connection failed")),
      );
    });
  }

  // `sendMessage` and `resumeSession` share the same wire shape: the
  // operation returns an `event`-framed iterable that ends with a
  // `[DONE]` payload (see `session-stream-delivery.ts` and the brief's
  // "two facts that make this ticket small"). One helper keeps the
  // close/error race in lockstep across both operations.
  function stream(
    operation: string,
    body: unknown,
    onFrame: (frame: WebuiStreamFrame) => void,
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      const ws = new webSocket(websocketUrl());
      const requestId = crypto.randomUUID();
      let settled = false;
      const fail = (error: Error) => {
        if (settled) return;
        settled = true;
        ws.close();
        reject(error);
      };
      ws.addEventListener("open", () =>
        ws.send(
          JSON.stringify({
            protocolVersion: 1,
            kind: "request",
            requestId,
            operation,
            body,
          }),
        ),
      );
      ws.addEventListener("message", (event) => {
        let frame: WireFrame;
        try {
          frame = JSON.parse(String(event.data)) as WireFrame;
        } catch {
          fail(new Error("WebUI returned invalid JSON"));
          return;
        }
        if (frame.requestId !== requestId) return;
        if (frame.kind === "error") {
          fail(new Error(frame.message ?? `${operation} refused`));
          return;
        }
        if (frame.kind !== "event") return;
        const streamFrame = frame.body as WebuiStreamFrame;
        onFrame(streamFrame);
        if (streamFrame.dataJson === "[DONE]") {
          settled = true;
          ws.close();
          resolve();
        }
      });
      ws.addEventListener("close", () =>
        fail(new Error("WebUI connection closed before [DONE]")),
      );
      ws.addEventListener("error", () =>
        fail(new Error("WebUI connection failed")),
      );
    });
  }

  function watchTerminal(requestBody: { readonly terminalId: string }, onFrame: (frame: WebuiTerminalFrame) => void): () => void {
    let stopped = false;
    const ws = new webSocket(websocketUrl());
    const requestId = crypto.randomUUID();
    ws.addEventListener("open", () => ws.send(JSON.stringify({ protocolVersion: 1, kind: "request", requestId, operation: "watchTerminal", body: requestBody })));
    ws.addEventListener("message", (event) => {
      if (stopped) return;
      let frame: WireFrame;
      try { frame = JSON.parse(String(event.data)) as WireFrame; } catch { return; }
      if (frame.requestId === requestId && frame.kind === "event" && frame.body && typeof frame.body === "object") onFrame(frame.body as WebuiTerminalFrame);
    });
    return () => { stopped = true; ws.close(); };
  }

  return {
    version: () => request<WebuiVersionInfo>("version", undefined),
    loadProjects: () => request<readonly WebuiClientProject[]>("listVisibleProjects", { limit: 100 }),
    loadSessions: (cursor) =>
      request<WebuiClientSessionPage>("listSessions", {
        name: "main",
        limit: 500,
        ...(cursor ? { cursor } : {}),
      }),
    loadSessionTree: (cursor) =>
      request<WebuiClientSessionTreePage>("getSessionTree", {
        name: "main",
        limit: 500,
        ...(cursor ? { cursor } : {}),
      }),
    listArchivedSessions: () => request<WebuiClientSessionPage>("listSessions", { name: "main", includeArchived: true, onlyArchived: true }),
    archiveSession: (body) => request("archiveSession", body),
    deleteSession: (body) => request("deleteSession", body),
    updateSession: (body) => request("updateSession", body),
    getSessionForkOptions: (body) => request("getSessionForkOptions", body),
    forkSession: (body) => request("forkSession", body),
    loadMessages: ({ id, before }) =>
      request<WebuiClientMessagePage>("getMessages", {
        id,
        ...(before ? { before } : {}),
      }),
    getSessionDiff: (body) => request("getSessionDiff", body),
    getTurnDiff: (body) => request("getTurnDiff", body),
    revertTurnDiff: (body) => request("revertTurnDiff", body),
    reapplyTurnDiff: (body) => request("reapplyTurnDiff", body),
    getSessionRewindPreview: (body) => request("getSessionRewindPreview", body),
    rewindSession: (body) => request("rewindSession", body),
    editSessionMessage: (body) => request("editSessionMessage", body),
    isGoalEnabled: () => request("isGoalEnabled", undefined),
    getActiveTurn: (body) => request("getActiveTurn", body),
    getGoal: (body) => request("getGoal", body),
    createGoal: (body) => request("createGoal", body),
    patchGoal: (body) => request("patchGoal", body),
    clearGoal: (body) => request("clearGoal", body),
    listWorkspaceFileTree: (body) => request("listWorkspaceFileTree", body),
    browseWorkspaceDirs: (body) => request("browseWorkspaceDirs", body),
    readWorkspaceFile: (body) => request("readWorkspaceFile", body),
    getWorkspaceEnvironment: (body) => request("getWorkspaceEnvironment", body),
    mutateWorkspaceGit: (body) => request("mutateWorkspaceGit", body),
    getWorkspaceReviewSummary: (body) => request("getWorkspaceReviewSummary", body),
    listWorkspaceReviewFileDiffs: (body) => request("listWorkspaceReviewFileDiffs", body),
    getWorkspaceReviewFileContent: (body) => request("getWorkspaceReviewFileContent", body),
    searchWorkspaceReviewDiffs: (body) => request("searchWorkspaceReviewDiffs", body),
    readCanvas: (body) => request("readCanvas", body),
    applyCanvas: (body) => request("applyCanvas", body),
    workspaceFileUrl: ({ workspaceDir, path: filePath }) => {
      // `ws:`/`wss:` share the `ws` prefix, so one substitution lands on
      // `http:`/`https:` respectively, and it must happen before the token is
      // appended — the server checks the token on this route like any other.
      const base = baseWebsocketUrl.replace(/\/$/u, "").replace(/^ws/iu, "http");
      const query = new URLSearchParams({ dir: workspaceDir, path: filePath, token });
      return `${base}/workspace-file?${query.toString()}`;
    },
    readWorkspaceArchive: (body) => request("readWorkspaceArchive", body),
    extractWorkspaceArchive: (body) => request("extractWorkspaceArchive", body),
    createTerminal: (body) => request("createTerminal", body),
    listTerminals: () => request("listTerminals", {}),
    writeTerminal: (body) => request("writeTerminal", body),
    disposeTerminal: (body) => request("disposeTerminal", body),
    watchTerminal,
    createSession: (body) => request("createSession", body),
    sendMessage: (body, onFrame) => stream("sendMessage", body, onFrame),
    enqueueMessage: (body) => request("enqueueMessage", body),
    resumeSession: (body, onFrame) => stream("resumeSession", body, onFrame),
    watchEvents: createWebuiEventChannel({ websocketUrl, webSocket }),
    listPendingPermissions: () => request("listPendingPermissions", {}),
    getPendingQuestionnaire: (body) => request("getPendingQuestionnaire", body),
    replyPermission: (body) => request("replyPermission", body),
    replyQuestionnaire: (body) => request("replyQuestionnaire", body),
    dismissQuestionnaire: (body) => request("dismissQuestionnaire", body),
    abortSession: (body) => request("abortSession", body),
    listQueueMessages: (body) => request("listQueueMessages", body),
    deleteQueueItem: (body) => request("deleteQueueItem", body),
    listModels: (body) => request("listModels", body ?? {}),
    listSkills: (body) => request("listSkills", body ?? {}),
    pluginManagement: (body) => request("pluginManagement", body),
    getPermissionMode: () => request("getPermissionMode", {}),
    setPermissionMode: (body) => request("setPermissionMode", body),
    getGlobalInstructions: () => request("getGlobalInstructions", {}),
    setGlobalInstructions: (body) => request("setGlobalInstructions", body),
    getAgentMemory: (body) => request("getAgentMemory", body ?? {}),
    setAgentMemory: (body) => request("setAgentMemory", body),
    getUserProfile: () => request("getUserProfile", {}),
    setUserProfile: (body) => request("setUserProfile", body),
    getMemorySettings: () => request("getMemorySettings", {}),
    setMemorySettings: (body) => request("setMemorySettings", body),
    selectModel: (body) => request("selectModel", body),
    getSessionUsage: (body) => request("getSessionUsage", body),
    getUsageQuota: (body) => request("getUsageQuota", body ?? {}),
    getSigninPanel: () => request("getSigninPanel", {}),
    claimSignin: () => request("claimSignin", {}),
    getAccountStatus: (body) => request("getAccountStatus", body ?? {}),
    listUserModelProviders: () => request("listUserModelProviders", undefined),
    createUserModelProvider: (body) => request("createUserModelProvider", body),
    updateUserModelProvider: (body) => request("updateUserModelProvider", body),
    deleteUserModelProvider: (providerId) => request("deleteUserModelProvider", { providerId }),
    testUserModelProvider: (body) => request("testUserModelProvider", body),
    testUserModel: (body) => request("testUserModel", body),
    discoverUserModelsCandidate: (body) => request("discoverUserModelsCandidate", body),
    saveUserModelProviderCandidate: (body) => request("saveUserModelProviderCandidate", body),
    listProviderPresets: () => request("listProviderPresets", undefined),
    getMiniMaxApiKeyStatus: () => request("getMiniMaxApiKeyStatus", undefined),
    upsertMiniMaxApiKey: (body) => request("upsertMiniMaxApiKey", body),
    getCodexOAuthStatus: () => request("getCodexOAuthStatus", undefined),
    getMiniMaxModelSource: () => request("getMiniMaxModelSource", undefined),
    setMiniMaxModelSource: (source) => request("setMiniMaxModelSource", { source }),
    testUserModelCandidate: (body) => request("testUserModelCandidate", body),
    revealModelProviderApiKey: (body) => request("revealModelProviderApiKey", body),
    startCodexOAuthLogin: (body) => request("startCodexOAuthLogin", body ?? {}),
    cancelCodexOAuthLogin: (body) => request("cancelCodexOAuthLogin", body),
    refreshModels: () => request("refreshModels", undefined),
    signOut: () => request("signOut", {}),
    beginAccountLogin: () => request("beginAccountLogin", {}),
    getAccountLoginStatus: () => request("getAccountLoginStatus", {}),
    cancelAccountLogin: () => request("cancelAccountLogin", {}),
    runCommand: (body) => request("runCommand", body),
  } satisfies Required<WebuiTransport>;
}
