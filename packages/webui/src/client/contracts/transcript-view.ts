// Browser-local transcript view types.
//
// The renderable transcript shapes the components consume, plus the
// questionnaire-response render record they carry. Split from the former
// `client/contracts.ts`. `WebuiQuestionnaireResponseSummary` and its answer
// record moved here from `projection/message-parts.ts` so this leaf contract
// no longer reaches into projection implementation.

import type { WebuiTurnDiffView } from "../../shared/contracts/session.js";
import type { WebuiMessageAttachment } from "./message-view.js";

/**
 * Which per-message toolbar actions the runtime offers for one message.
 *
 * Moved here from `components/MessageActions.tsx` so the pure transcript
 * projection (`projection/transcript-shape.ts`) can name it without importing
 * a React component (plan §3).
 */
export type WebuiMessageActionCapabilities = {
  readonly fork?: boolean;
  readonly rewind?: boolean;
  readonly edit?: boolean;
};

export interface WebuiQuestionnaireResponseAnswer {
  /** The question text from the trailing `Q:` line, when available. */
  readonly question: string;
  /** One human-readable label per answer; for multi-select responses we
   *  keep every option the user chose in order, joined by the renderer. */
  readonly labels: readonly string[];
}

export interface WebuiQuestionnaireResponseSummary {
  readonly requestId: string;
  readonly schemaVersion?: string;
  readonly submittedAt?: string;
  readonly mode?: string;
  readonly source?: string;
  readonly featureKey?: string;
  readonly answers: readonly WebuiQuestionnaireResponseAnswer[];
}

/* Transcript & diff view models — projection outputs the components consume. */

export type WebuiTranscriptItem =
  | {
      readonly kind: "user" | "assistant" | "thinking";
      readonly text: string;
      readonly messageId: string;
      /** Turn the message belongs to: the key the runtime accepts for a turn diff. */
      readonly turnId?: string;
      readonly durationMs?: number;
      readonly diff?: WebuiTurnDiffView;
      readonly actions?: { readonly fork?: boolean; readonly rewind?: boolean; readonly edit?: boolean };
      readonly timestamp?: number;
      readonly isGoal?: boolean;
      readonly attachments?: readonly WebuiMessageAttachment[];
      readonly usage?: Record<string, unknown>;
    }
  | {
      readonly kind: "tool";
      readonly messageId: string;
      readonly turnId?: string;
      readonly tools: readonly Record<string, unknown>[];
      readonly diff?: WebuiTurnDiffView;
      readonly actions?: { readonly fork?: boolean; readonly rewind?: boolean; readonly edit?: boolean };
      readonly timestamp?: number;
      readonly isGoal?: boolean;
      readonly usage?: Record<string, unknown>;
    }
  | {
      readonly kind: "questionnaire_response";
      readonly messageId: string;
      readonly turnId?: string;
      readonly summary: WebuiQuestionnaireResponseSummary;
      readonly timestamp?: number;
    }
  | {
      readonly kind: "activity";
      readonly messageId: string;
      readonly turnId?: string;
      readonly activityType: "cognitive" | "compaction" | "delegation" | "agent_joined" | "asset_list";
      readonly text?: string;
      readonly detail?: Record<string, unknown>;
      readonly timestamp?: number;
    };

/** One Desktop-style thinking/tool segment inside an assistant turn. */
export interface WebuiTranscriptProcessSegment {
  readonly messageId: string;
  readonly thinking?: string;
  readonly thinkingDurationMs?: number;
  readonly tools?: readonly Record<string, unknown>[];
  readonly activityParts?: readonly WebuiTranscriptActivityPart[];
}

export type WebuiTranscriptActivityPart =
  | { readonly type: "thinking"; readonly text: string; readonly durationMs?: number }
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "cognitive"; readonly text: string }
  | { readonly type: "compaction"; readonly text: string }
  | { readonly type: "tool"; readonly tool: Record<string, unknown> }
  | { readonly type: "delegation"; readonly message: Record<string, unknown> }
  | { readonly type: "agent_joined"; readonly agent: Record<string, unknown> }
  | { readonly type: "asset_list"; readonly assets: readonly Record<string, unknown>[] };
