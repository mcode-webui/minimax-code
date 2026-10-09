// Session capability port.
//
// Session list/tree/lookup/update/fork and the session-scoped diff, rewind and
// edit operations. Split from the monolithic `WebuiTransport` in the former
// `client/contracts.ts`; `transport.ts` composes it. Every method stays
// optional — `undefined` means "the operation is not wired".

import type {
  WebuiClientProject,
  WebuiClientSessionPage,
  WebuiClientSessionTreePage,
} from "./session-view.js";
import type { WebuiClientMessageLoader } from "./message-view.js";
import type {
  WebuiEditSessionMessageRequest,
  WebuiEditSessionMessageResult,
  WebuiForkSessionRequest,
  WebuiForkSessionResult,
  WebuiGetSessionDiffRequest,
  WebuiGetSessionDiffResult,
  WebuiGetSessionForkOptionsRequest,
  WebuiGetSessionForkOptionsResult,
  WebuiGetSessionRewindPreviewRequest,
  WebuiGetSessionRewindPreviewResult,
  WebuiGetTurnDiffRequest,
  WebuiGetTurnDiffResult,
  WebuiReapplyTurnDiffRequest,
  WebuiReapplyTurnDiffResult,
  WebuiRevertTurnDiffRequest,
  WebuiRevertTurnDiffResult,
  WebuiRewindSessionRequest,
  WebuiRewindSessionResult,
  WebuiUpdateSessionRequest,
  WebuiUpdateSessionResult,
} from "../../shared/contracts/session.js";

export type WebuiClientSessionTreeLoader = (
  cursor?: string,
) => Promise<WebuiClientSessionTreePage>;

export type WebuiClientSessionLoader = (
  cursor?: string,
) => Promise<WebuiClientSessionPage>;

export interface WebuiClientCreateSessionRequest {
  readonly name: string;
  /** Optional: absent means "use the default workspace" (harness resolves it). */
  readonly workspaceDir?: string;
  readonly teamModeOff?: boolean;
}

export interface WebuiClientCreateSessionResult {
  readonly sessionId?: string;
  readonly session?: {
    readonly sessionId?: string;
    readonly workspaceDir?: string;
  };
}

export type WebuiClientSessionCreator = (
  request: WebuiClientCreateSessionRequest,
) => Promise<WebuiClientCreateSessionResult>;

export interface SessionPort {
  readonly loadProjects?: () => Promise<readonly WebuiClientProject[]>;
  readonly listArchivedSessions?: () => Promise<WebuiClientSessionPage>;
  readonly loadSessions?: WebuiClientSessionLoader;
  readonly loadSessionTree?: WebuiClientSessionTreeLoader;
  readonly loadMessages?: WebuiClientMessageLoader;
  readonly getSessionDiff?: (
    request: WebuiGetSessionDiffRequest,
  ) => Promise<WebuiGetSessionDiffResult>;
  readonly getTurnDiff?: (
    request: WebuiGetTurnDiffRequest,
  ) => Promise<WebuiGetTurnDiffResult>;
  readonly revertTurnDiff?: (
    request: WebuiRevertTurnDiffRequest,
  ) => Promise<WebuiRevertTurnDiffResult>;
  readonly reapplyTurnDiff?: (
    request: WebuiReapplyTurnDiffRequest,
  ) => Promise<WebuiReapplyTurnDiffResult>;
  readonly getSessionRewindPreview?: (
    request: WebuiGetSessionRewindPreviewRequest,
  ) => Promise<WebuiGetSessionRewindPreviewResult>;
  readonly rewindSession?: (
    request: WebuiRewindSessionRequest,
  ) => Promise<WebuiRewindSessionResult>;
  readonly editSessionMessage?: (
    request: WebuiEditSessionMessageRequest,
  ) => Promise<WebuiEditSessionMessageResult>;
  readonly createSession?: WebuiClientSessionCreator;
  readonly archiveSession?: (request: {
    readonly id: string;
    readonly archived?: boolean;
  }) => Promise<{ readonly success?: boolean }>;
  readonly deleteSession?: (request: {
    readonly id: string;
  }) => Promise<{ readonly success?: boolean }>;
  readonly updateSession?: (
    request: WebuiUpdateSessionRequest,
  ) => Promise<WebuiUpdateSessionResult>;
  readonly getSessionForkOptions?: (
    request: WebuiGetSessionForkOptionsRequest,
  ) => Promise<WebuiGetSessionForkOptionsResult>;
  readonly forkSession?: (
    request: WebuiForkSessionRequest,
  ) => Promise<WebuiForkSessionResult>;
  readonly getSessionUsage?: (request: {
    readonly id: string;
  }) => Promise<Record<string, unknown>>;
}
