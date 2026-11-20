import type {
  AskQuestionnaireMode,
  AskQuestionnaireReplyAnswer,
  AskQuestionnaireRequest,
} from '@mavis/shared/questionnaire';

import type {
  DisplayMessageRecord,
  ResumeSessionInput,
  SessionFrame,
} from '../session-system/index.js';
import type { LocalConversationRuntimeConfig } from '../model-system/index.js';
import type { AbortTurnResult, SteerSessionInput } from '../turn-system/index.js';

/**
 * The neutral session/turn seam shared by every internal Agent consumer.
 *
 * It deliberately names no Plugin, Mini App or Design concept: a consumer owns
 * its session records and its event vocabulary, while this module owns the
 * post-policy turn lifecycle (subscribe, steer, follow, answer, cancel).
 */
export type AgentTurnModelSelection = {
  readonly providerId: string;
  readonly modelId: string;
  readonly variant?: string;
  readonly thinking?: { readonly effort: string };
};

export type AgentTurnRunStatus = 'finished' | 'error' | 'aborted';

/** A narrowing tool selection, applied on the server to the Turn's own profile. */
export interface AgentTurnCapabilitySelection {
  readonly tools?: readonly string[];
  readonly disallowedTools?: readonly string[];
  readonly mcpServers?: readonly string[];
  readonly skills?: readonly string[];
  readonly extensionSkills?: readonly string[];
}

/** The neutral error a consumer may subclass to keep its own `instanceof` checks. */
export class AgentTurnError extends Error {
  override readonly name: string = 'AgentTurnError';
  readonly code: string;
  readonly retryable: boolean;
  declare readonly reason?: string;

  constructor(code: string, message: string, retryable = false, reason?: string) {
    super(message);
    this.code = code;
    this.retryable = retryable;
    if (reason !== undefined) this.reason = reason;
  }
}

export type AgentTurnPermissionDecision = 'allowOnce' | 'deny';

export interface AgentTurnPermissionAsk {
  readonly sessionId: string;
  readonly turnId?: string;
  readonly requestId: string;
  readonly toolName: string;
  readonly toolInput?: string;
  readonly reason: string;
}

export type AgentTurnRunEvent =
  | { readonly type: 'run.queued'; readonly sessionId?: string; readonly position: number }
  | {
      readonly type: 'turn.started';
      readonly sessionId: string;
      readonly turnId: string;
      readonly model: AgentTurnModelSelection;
    }
  | {
      readonly type: 'text.delta';
      readonly sessionId: string;
      readonly turnId: string;
      readonly text: string;
    }
  | {
      readonly type: 'message.committed';
      readonly sessionId: string;
      readonly turnId: string;
      readonly text: string;
    }
  | {
      readonly type: 'tool.started';
      readonly sessionId: string;
      readonly turnId: string;
      readonly name: string;
    }
  | {
      readonly type: 'tool.finished';
      readonly sessionId: string;
      readonly turnId: string;
      readonly name: string;
      readonly ok: boolean;
    }
  | {
      readonly type: 'permission.requested';
      readonly sessionId: string;
      readonly turnId?: string;
      readonly requestId: string;
      readonly toolName: string;
      readonly toolInput?: string;
      readonly reason: string;
    }
  | {
      readonly type: 'question.requested';
      readonly sessionId: string;
      readonly turnId?: string;
      readonly requestId: string;
      readonly mode: AskQuestionnaireMode;
      readonly request: AskQuestionnaireRequest;
    }
  | {
      readonly type: 'turn.finished';
      readonly sessionId: string;
      readonly turnId: string;
      readonly status: AgentTurnRunStatus;
      readonly text?: string;
      readonly error?: { readonly code: string; readonly message: string };
    };

export interface AgentTurnResult {
  /** Set by the consumer that owns the session; the neutral follower does not invent it. */
  readonly sessionId?: string;
  readonly turnId?: string;
  readonly model?: AgentTurnModelSelection;
  readonly status: AgentTurnRunStatus;
  readonly text?: string;
  readonly error?: { readonly code: string; readonly message: string };
  readonly pendingQuestion?: {
    readonly requestId: string;
    readonly mode: AskQuestionnaireMode;
    readonly request: AskQuestionnaireRequest;
  };
}

export interface AgentTurnRunInput {
  readonly sessionId: string;
  readonly text: string;
  readonly signal?: AbortSignal;
  readonly onEvent?: (event: AgentTurnRunEvent) => void;
  /** Server-enforced narrowing of the Turn's tool/skill profile. Never widens it. */
  readonly capabilitySelection?: AgentTurnCapabilitySelection;
}

export interface AgentTurnAnswerInput {
  readonly sessionId: string;
  readonly requestId: string;
  readonly answers: readonly AskQuestionnaireReplyAnswer[];
  readonly signal?: AbortSignal;
  readonly onEvent?: (event: AgentTurnRunEvent) => void;
  readonly capabilitySelection?: AgentTurnCapabilitySelection;
}

export interface AgentTurnSessionOptions {
  /** Provenance label written on the Turn; consumers own their own value. */
  readonly source: string;
  /** Human-readable prefix for diagnostics; defaults to "Agent". */
  readonly label?: string;
  readonly repository: {
    get(sessionId: string): Promise<
      | {
          readonly agentName?: string;
          readonly effectiveModel?: string | null;
          readonly effectiveModelVariant?: string | null;
          readonly effectiveModelThinking?: { readonly effort?: string } | null;
        }
      | undefined
    >;
  };
  readonly turns: {
    steer(input: SteerSessionInput): Promise<
      | { readonly delivered: true; readonly mode: 'steered' | 'duplicate'; readonly turnId: string }
      | { readonly delivered: true; readonly mode: 'activated'; readonly turnId: string }
      | { readonly delivered: false; readonly reason: string }
    >;
    abort(input: {
      readonly sessionId: string;
      readonly turnId: string;
      readonly reason: string;
    }): Promise<AbortTurnResult>;
  };
  readonly stream: {
    resume(input: ResumeSessionInput): AsyncIterableIterator<SessionFrame>;
  };
  readonly messages: {
    listTurn(sessionId: string, turnId: string): Promise<readonly DisplayMessageRecord[]>;
    listRecent(
      sessionId: string,
      options: { readonly limit: number; readonly role?: string },
    ): Promise<readonly DisplayMessageRecord[]>;
  };
  readonly questionnaires: {
    getPending(input: {
      agentName: string;
      sessionId: string;
    }): Promise<AskQuestionnaireRequest | undefined>;
    reply(input: {
      agentName: string;
      requestId: string;
      answers: AskQuestionnaireReplyAnswer[];
      submittedAt: number;
    }): Promise<{ readonly ok: true; readonly injected?: boolean }>;
  };
  readonly logger: {
    warn(fields: Record<string, unknown>, message: string): void;
  };
  readonly modelConfig: () => LocalConversationRuntimeConfig;
  readonly nowMs: () => number;
  /** The consumer's own error type, so `instanceof` checks stay meaningful. */
  readonly createError: (
    code: string,
    message: string,
    retryable?: boolean,
    reason?: string,
  ) => Error & { readonly code: string; readonly retryable?: boolean };
  /** Whether an error came from `createError` (and may be rethrown unchanged). */
  readonly isError?: (error: unknown) => boolean;
}

export interface AgentTurnSession {
  run(input: AgentTurnRunInput): Promise<AgentTurnResult>;
  answer(input: AgentTurnAnswerInput): Promise<AgentTurnResult>;
}
