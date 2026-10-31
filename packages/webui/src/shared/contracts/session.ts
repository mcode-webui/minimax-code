// Wire contract record: every exported declaration below records its wire
// purpose, its producer and its consumers, verified against the tree.
// Documentation only.
//
// | Declaration | Wire purpose | Producer | Consumers |
// | --- | --- | --- | --- |
// | `WebuiSessionListRequest` | Session list query (name, paging, filters). | Browser `client/platform/transport.ts` (`listSessions`). | runtime `listSessions`; `server/operation/session.ts`. |
// | `WebuiSessionListItem` | One session in a list/tree page. | Runtime `listSessions`/`getSessionTree` (`runtime/harness/sessions.ts`; CliService). | `client/features/settings/ui/SettingsModal.tsx`; `server/index.ts` (barrel). |
// | `WebuiSessionPage` | A page of session-list results. | Runtime `listSessions`. | `client/features/sessions/contracts/session-port.ts`; `server/operation/session.ts`. |
// | `WebuiProjectRecord` | One visible project (rail grouping). | Runtime `listVisibleProjects` (`runtime/harness/sessions.ts`). | `client/features/sessions/contracts/session-view.ts` (`WebuiClientProject`); `server/operation/session.ts`. |
// | `WebuiSessionTreeRequest` | Session tree query (name, paging, filters). | Browser `client/platform/transport.ts` (`getSessionTree`). | runtime `getSessionTree`; `server/operation/session.ts`. |
// | `WebuiSessionTreeNode` | One parent session with its child sessions. | Runtime `getSessionTree`. | `server/index.ts` (barrel). |
// | `WebuiSessionTreePage` | A page of session-tree results. | Runtime `getSessionTree`. | `client/features/sessions/contracts/session-port.ts`; `server/operation/session.ts`. |
// | `WebuiSessionLookupRequest` | Request to look up one session by id. | Browser `client/platform/transport.ts` (`getSession`). | `server/operation/common.ts`; runtime `getSession`. |
// | `WebuiActiveTurn` | Authoritative active-turn probe (turnId, busyReason, locallyOwned). | Runtime `getActiveTurn` (`runtime/harness/execution.ts`; CliService). | `client/features/sessions/projection/session-activity.ts`. |
// | `WebuiActiveTurnResult` | The active turn, or undefined when idle. | Runtime `getActiveTurn`. | `client/features/turn/contracts/execution-port.ts`; `client/features/composer/ui/WebuiComposer.tsx`. |
// | `WebuiActiveTurnRequest` | Request naming the session whose active turn is probed. | Browser `client/platform/transport.ts` (`getActiveTurn`). | `client/features/turn/contracts/active-turn-probe.ts`; `client/features/turn/contracts/execution-port.ts`; `client/features/composer/ui/WebuiComposer.tsx`. |
// | `WebuiSessionInfo` | The session identity/fields returned by lookup and mutations. | Runtime `getSession`/`updateSession`/`forkSession`/`createSession`. | `server/service.ts` (session-transfer route); `server/index.ts` (barrel). |
// | `WebuiSessionLookupResult` | The `{ session }` envelope from a lookup. | Runtime `getSession`. | `client/features/sessions/contracts/session-port.ts`; `server/operation/session.ts`. |
// | `WebuiUpdateSessionRequest` | Request to set a session title. | Browser `client/platform/transport.ts` (`updateSession`). | `server/operation/session.ts`; runtime `updateSession`. |
// | `WebuiUpdateSessionResult` | The updated `{ session }`. | Runtime `updateSession`. | `server/operation/session.ts`; `client/features/sessions/contracts/session-port.ts`. |
// | `WebuiForkSessionRequest` | Request to fork a session. | Browser `client/platform/transport.ts`; built in `client/features/sessions/projection/action-requests.public.ts` (`forkSession`). | `server/operation/session.ts`; runtime `forkSession`. |
// | `WebuiGetSessionForkOptionsRequest` | Request for fork options. | Browser `client/platform/transport.ts`. | `server/operation/session.ts`; runtime `getSessionForkOptions`. |
// | `WebuiGetSessionForkOptionsResult` | Whether/where a session can be forked. | Runtime `getSessionForkOptions`. | `server/operation/session.ts`; `client/features/sessions/contracts/session-port.ts`; `client/features/transcript/ui/MessageItem.tsx`. |
// | `WebuiForkSessionResult` | The forked session and its lineage ids. | Runtime `forkSession`. | `server/operation/session.ts`; `client/features/sessions/contracts/session-port.ts`. |
// | `WebuiCreateSessionRequest` | Request to create a session (name, workspace, teamModeOff). | Browser `client/platform/transport.ts` (`createSession`). | runtime `createSession`; `server/operation/session.ts`; `server/service.ts`. |
// | `WebuiSessionTransferFile` | A round-trippable session export (canonical + display layers). | Runtime `exportSessionTransfer` (`runtime/harness/sessions.ts`; CliService). | `runtime/port.ts` capability surface only; no src reader beyond it. |
// | `WebuiImportSessionTransferRequest` | Request to import a session transfer into a target session. | HTTP route `server/service.ts` (session-transfer handler). | runtime `importSessionTransfer`; `runtime/port.ts`. |
// | `WebuiImportSessionTransferResult` | Counts and revision after an import. | Runtime `importSessionTransfer`. | `runtime/port.ts` capability surface only. |
// | `WebuiCreateSessionResult` | The created session info. | Runtime `createSession`. | `client/features/sessions/contracts/session-port.ts`; `server/operation/session.ts`. |
// | `WebuiFileDiffInfoView` | One file's add/delete counts and patch in a session/turn diff. | Runtime `getSessionDiff`/`getTurnDiff` (`runtime/harness/sessions.ts`); also `client/features/transcript/projection/message-projection.ts`. | `client/features/transcript/contracts/message-view.ts`; `client/features/workspace/ui/WorkspacePanels.tsx`. |
// | `WebuiTurnDiffView` | A turn's reversible diff state. | Runtime `getTurnDiff`/`revertTurnDiff`/`reapplyTurnDiff`; also `client/features/transcript/projection/message-projection.ts`. | `client/features/transcript/contracts/transcript-view.ts`; `client/features/review/contracts/review-view.ts`; `client/features/transcript/ui/DiffCard.tsx`; `client/features/transcript/ui/AssistantBody.tsx`; `client/features/workspace/projection/workspace-panel-state.ts`. |
// | `WebuiGetSessionDiffRequest` | Request for a session-level diff. | Browser `client/platform/transport.ts`. | `server/operation/messages.ts`; runtime `getSessionDiff`. |
// | `WebuiGetSessionDiffResult` | Session-level diff result. | Runtime `getSessionDiff`. | `client/features/sessions/contracts/session-port.ts`; `server/operation/messages.ts`. |
// | `WebuiGetTurnDiffRequest` | Request for one turn's diff. | Browser `client/platform/transport.ts`; requested from `client/features/transcript/ui/DiffCard.tsx`. | `server/operation/messages.ts`; runtime `getTurnDiff`. |
// | `WebuiGetTurnDiffResult` | One turn's diff. | Runtime `getTurnDiff`. | `client/features/sessions/contracts/session-port.ts`; `server/operation/messages.ts`. |
// | `WebuiRevertTurnDiffRequest` | Request to revert a turn's diff. | Browser `client/platform/transport.ts`; requested from `client/features/transcript/ui/DiffCard.tsx`. | `server/operation/messages.ts`; runtime `revertTurnDiff`. |
// | `WebuiRevertTurnDiffResult` | Revert outcome. | Runtime `revertTurnDiff`. | `client/features/sessions/contracts/session-port.ts`; `client/features/transcript/ui/DiffCard.tsx`. |
// | `WebuiReapplyTurnDiffRequest` | Request to reapply a reverted turn diff. | Browser `client/platform/transport.ts`; requested from `client/features/transcript/ui/DiffCard.tsx`. | `server/operation/messages.ts`; runtime `reapplyTurnDiff`. |
// | `WebuiReapplyTurnDiffResult` | Reapply outcome. | Runtime `reapplyTurnDiff`. | `client/features/sessions/contracts/session-port.ts`; `client/features/transcript/ui/DiffCard.tsx`. |
// | `WebuiGetSessionRewindPreviewRequest` | Request for a rewind preview. | Browser `client/platform/transport.ts`. | `server/operation/messages.ts`; runtime `getSessionRewindPreview`. |
// | `WebuiRewindPreviewFile` | One file action in a rewind preview turn. | Runtime `getSessionRewindPreview`. | unverified — nested in `WebuiRewindPreviewTurn.files`; no direct importer. |
// | `WebuiRewindPreviewTurn` | One turn's file actions in a rewind preview. | Runtime `getSessionRewindPreview`. | unverified — nested in `WebuiGetSessionRewindPreviewResult.turns`; no direct importer. |
// | `WebuiGetSessionRewindPreviewResult` | The rewind preview (turns and file actions). | Runtime `getSessionRewindPreview`. | `client/features/transcript/ui/MessageActions.tsx`; `client/features/transcript/ui/MessageItem.tsx`. |
// | `WebuiRewindSessionRequest` | Request to rewind a session to a user message. | Browser `client/platform/transport.ts`; built in `client/features/sessions/projection/action-requests.public.ts`. | `server/operation/messages.ts`; runtime `rewindSession`. |
// | `WebuiRewindSessionResult` | Rewind outcome (revisions, deleted ids). | Runtime `rewindSession`. | `client/features/sessions/contracts/session-port.ts`; `server/operation/messages.ts`. |
// | `WebuiEditSessionMessageRequest` | Request to edit a user message and rewind. | Browser `client/platform/transport.ts`; built in `client/features/sessions/projection/action-requests.public.ts`. | `server/operation/messages.ts`; runtime `editSessionMessage`. |
// | `WebuiEditSessionMessageResult` | Edit/rewind outcome. | Runtime `editSessionMessage`. | `client/features/sessions/contracts/session-port.ts`; `server/operation/messages.ts`. |
export interface WebuiSessionListRequest {
  readonly name: string;
  readonly limit?: number;
  readonly offset?: number;
  readonly cursor?: string;
  readonly includeArchived?: boolean;
  readonly onlyArchived?: boolean;
  readonly onlyCompressed?: boolean;
  readonly includeHidden?: boolean;
  readonly includePurposePrefix?: string;
  readonly excludePurposePrefix?: string;
}

export interface WebuiSessionListItem {
  readonly sessionId: string;
  readonly agentName: string;
  readonly sessionType?: string;
  readonly archived?: boolean;
  readonly status?: unknown;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly workspaceDir?: string;
  readonly frameworkType?: string;
  readonly isDefaultWorkspace?: boolean;
  readonly visibility?: string;
  readonly sessionKind?: string;
  readonly title?: string;
  readonly parentSessionId?: string;
  readonly purpose?: string;
}

export interface WebuiSessionPage {
  readonly sessions: readonly WebuiSessionListItem[];
  readonly hasMore: boolean;
  readonly nextCursor?: string;
}

export interface WebuiProjectRecord {
  readonly projectId: number;
  readonly projectKind: "default" | "workspace";
  readonly workspaceDir: string | null;
  readonly pinned: boolean;
  readonly hidden: boolean;
  readonly orderIndex: number;
  readonly recentAtMs: number | null;
  readonly latestActivityAtMs: number;
  readonly sessionCount: number;
}

export interface WebuiSessionTreeRequest {
  readonly name: string;
  readonly limit?: number;
  readonly cursor?: string;
  readonly includeArchived?: boolean;
  readonly onlyArchived?: boolean;
  readonly onlyCompressed?: boolean;
  readonly includeHidden?: boolean;
  readonly includePurposePrefix?: string;
  readonly excludePurposePrefix?: string;
}

export interface WebuiSessionTreeNode {
  readonly session: WebuiSessionListItem;
  readonly childSessions: readonly WebuiSessionListItem[];
}

export interface WebuiSessionTreePage {
  readonly sessions: readonly WebuiSessionTreeNode[];
  readonly hasMore: boolean;
  readonly nextCursor?: string;
}

export interface WebuiSessionLookupRequest {
  readonly id: string;
}

/**
 * Authoritative active-turn probe. `busyReason: "compaction"` means the
 * session is busy but is not producing an assistant transcript, so callers
 * that need a message stream must not attach on that alone.
 */
export interface WebuiActiveTurn {
  readonly turnId: string;
  readonly busyReason: "turn" | "compaction";
  readonly locallyOwned: boolean;
}

export type WebuiActiveTurnResult = WebuiActiveTurn | undefined;

export interface WebuiActiveTurnRequest {
  readonly id: string;
}
export interface WebuiSessionInfo {
  readonly sessionId?: string;
  readonly agentName?: string;
  readonly title?: string;
  readonly createdAt?: number;
  readonly updatedAt?: number;
  readonly workspaceDir?: string;
  readonly [key: string]: unknown;
}
export interface WebuiSessionLookupResult {
  readonly session?: WebuiSessionInfo;
}
export interface WebuiUpdateSessionRequest {
  readonly id: string;
  readonly title?: string;
}
export interface WebuiUpdateSessionResult {
  readonly session?: WebuiSessionInfo;
}
export interface WebuiForkSessionRequest {
  readonly id: string;
  readonly assistantMessageId?: string;
  readonly clientRequestId: string;
  readonly title?: string;
  readonly useSuggestedTitle: boolean;
  readonly createIsolatedWorktree: boolean;
}
export interface WebuiGetSessionForkOptionsRequest {
  readonly id: string;
  readonly assistantMessageId?: string;
}
export interface WebuiGetSessionForkOptionsResult {
  readonly canFork: boolean;
  readonly unavailableReason?: string;
  readonly suggestedTitle?: string;
  readonly nextForkOrdinal?: number;
  readonly sourceTitle?: string;
  readonly worktreeVisible: boolean;
  readonly worktreeEligible: boolean;
  readonly worktreeUnavailableReason?: string;
}
export interface WebuiForkSessionResult {
  readonly session?: WebuiSessionInfo;
  readonly forkOriginMessageId?: string;
  readonly sourceDisplayMessageId?: string;
  readonly displayRevision?: string;
  readonly historyRevision?: string;
}
export interface WebuiCreateSessionRequest {
  readonly name: string;
  /** Optional: absent means "use the default workspace" (harness resolves it). */
  readonly workspaceDir?: string;
  readonly teamModeOff?: boolean;
}

/**
 * A session in the shape that survives a round trip.
 *
 * Both layers are present because neither is recoverable from the other: the
 * canonical layer is what the model reads on the next turn, the display layer
 * is what the user reads. A file carrying only one of them imports as a
 * conversation that is half-gone.
 */
export interface WebuiSessionTransferFile {
  readonly format: string;
  readonly exportedAt: string;
  readonly session: {
    readonly sessionId: string;
    readonly title: string;
    readonly agentName?: string;
    readonly workspaceDir?: string;
  };
  readonly canonical: {
    readonly envelopes: readonly {
      readonly message_id: string;
      readonly turn_id: string;
      readonly message: unknown;
    }[];
    /**
     * Compaction snapshots the active file is chained to.
     *
     * Not optional history, and the reason this field exists in the type at
     * all. Each generation's file names its parent by
     * `(generation, compactionId)`, and the import scanner walks the whole
     * lineage before it accepts anything -- a file carrying only the active
     * generation dies with `parent-snapshot-missing` the moment the session
     * has ever been compacted. Nothing is lost today because the route
     * serialises the runtime's value verbatim, but a type that omits the
     * field is a type that permits the next refactor to rebuild the payload
     * without it, and that refactor passes every test in this repository.
     */
    readonly snapshots: readonly {
      readonly generation: number;
      readonly fileName: string;
      readonly revision: string;
      readonly records: readonly {
        readonly message_id: string;
        readonly turn_id: string;
        readonly message: unknown;
      }[];
    }[];
    readonly generation: number;
    readonly revision: string;
  };
  readonly display: {
    readonly messages: readonly Record<string, unknown>[];
  };
}

export interface WebuiImportSessionTransferRequest {
  /** The session the caller just created to receive the history. */
  readonly targetSessionId: string;
  /** Informational lineage only; never trusted for anything else. */
  readonly sourceSessionId?: string;
  /** Untrusted. The runtime validates the whole payload before writing. */
  readonly file: unknown;
}

export interface WebuiImportSessionTransferResult {
  readonly sessionId: string;
  readonly canonicalMessages: number;
  readonly displayMessages: number;
  readonly revision: string;
}
export interface WebuiCreateSessionResult {
  readonly agentName?: string;
  readonly sessionId?: string;
  readonly session?: WebuiSessionInfo;
}

export interface WebuiFileDiffInfoView {
  readonly file: string;
  readonly additions: number;
  readonly deletions: number;
  readonly status?: string;
  readonly diff?: string;
  readonly patch?: Record<string, unknown>;
}

export interface WebuiTurnDiffView {
  readonly fileChanges?: readonly WebuiFileDiffInfoView[];
  readonly sourceMessageId?: string;
  readonly changeSetId?: string;
  readonly status?: string;
  readonly revertedAt?: number;
  readonly canUndo?: boolean;
  readonly canReapply?: boolean;
}

export interface WebuiGetSessionDiffRequest {
  readonly id: string;
  readonly messageId?: string;
}

export interface WebuiGetSessionDiffResult {
  readonly diffs?: readonly WebuiFileDiffInfoView[];
  readonly changeSetId?: string;
}

export interface WebuiGetTurnDiffRequest {
  readonly id: string;
  readonly assistantMessageId?: string;
  readonly turnId?: string;
  readonly changeSetId?: string;
}

export interface WebuiGetTurnDiffResult extends WebuiTurnDiffView {}

export interface WebuiRevertTurnDiffRequest extends WebuiGetTurnDiffRequest {}
export interface WebuiRevertTurnDiffResult {
  readonly success?: boolean;
  readonly error?: string;
  readonly turnDiff?: WebuiTurnDiffView;
}

export interface WebuiReapplyTurnDiffRequest extends WebuiGetTurnDiffRequest {}
export interface WebuiReapplyTurnDiffResult extends WebuiTurnDiffView {
  readonly success: boolean;
  readonly error?: string;
}

export interface WebuiGetSessionRewindPreviewRequest {
  readonly id: string;
  readonly userMessageId: string;
}

export interface WebuiRewindPreviewFile {
  readonly filePath: string;
  readonly action: string;
  readonly skipped: boolean;
}

export interface WebuiRewindPreviewTurn {
  readonly turnId: string;
  readonly files: readonly WebuiRewindPreviewFile[];
}

export interface WebuiGetSessionRewindPreviewResult {
  readonly turns: readonly WebuiRewindPreviewTurn[];
}

export interface WebuiRewindSessionRequest {
  readonly id: string;
  readonly userMessageId: string;
  readonly clientRequestId: string;
  readonly rewindTurnDiff?: boolean;
}

export interface WebuiRewindSessionResult {
  readonly rewound: boolean;
  readonly displayRevision?: string;
  readonly historyRevision?: string;
  readonly deletedMessageIds?: readonly string[];
  readonly turnDiffRewind?: {
    readonly status: string;
    readonly revertedTurnIds?: readonly string[];
    readonly errorCode?: string;
  };
}

export interface WebuiEditSessionMessageRequest {
  readonly id: string;
  readonly userMessageId: string;
  readonly clientRequestId: string;
  readonly content: string;
  readonly attachments?: readonly Record<string, unknown>[];
  readonly rewindTurnDiff?: boolean;
}

export interface WebuiEditSessionMessageResult {
  readonly rewound: boolean;
  readonly turnId?: string;
  readonly userMessageId?: string;
  readonly displayRevision?: string;
  readonly historyRevision?: string;
  readonly deletedMessageIds?: readonly string[];
}
