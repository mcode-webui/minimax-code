// Interaction capability port.
//
// Permissions, questionnaires and the session goal. Split from the monolithic
// `WebuiTransport` in the former `client/contracts.ts`; `transport.ts`
// composes it. Every method stays optional — `undefined` means "the operation
// is not wired".

import type {
  WebuiGoal,
  WebuiGoalCreateRequest,
  WebuiGoalEnabledResult,
  WebuiGoalPatchRequest,
  WebuiGoalSessionRequest,
} from "../../shared/contracts/goal.js";
import type {
  WebuiInteractionReplyResult,
  WebuiPendingPermission,
  WebuiQuestionnaireAnswer,
  WebuiQuestionnaireRequest,
} from "../../shared/contracts/interactions.js";

export interface InteractionPort {
  readonly listPendingPermissions?: () => Promise<{
    readonly requests: readonly WebuiPendingPermission[];
  }>;
  readonly getPendingQuestionnaire?: (request: {
    readonly name: string;
    readonly sessionId: string;
  }) => Promise<{ readonly request?: WebuiQuestionnaireRequest }>;
  readonly replyPermission?: (request: {
    readonly name: string;
    readonly requestId: string;
    readonly reply: "allowOnce" | "allowAlways" | "deny";
  }) => Promise<WebuiInteractionReplyResult>;
  readonly replyQuestionnaire?: (request: {
    readonly name: string;
    readonly requestId: string;
    readonly schemaVersion: number;
    readonly answers: readonly WebuiQuestionnaireAnswer[];
  }) => Promise<WebuiInteractionReplyResult>;
  readonly dismissQuestionnaire?: (request: {
    readonly name: string;
    readonly requestId: string;
  }) => Promise<WebuiInteractionReplyResult>;
  readonly isGoalEnabled?: () => Promise<WebuiGoalEnabledResult>;
  readonly getGoal?: (
    request: WebuiGoalSessionRequest,
  ) => Promise<WebuiGoal | undefined>;
  readonly createGoal?: (request: WebuiGoalCreateRequest) => Promise<WebuiGoal>;
  readonly patchGoal?: (request: WebuiGoalPatchRequest) => Promise<WebuiGoal>;
  readonly clearGoal?: (
    request: WebuiGoalSessionRequest,
  ) => Promise<{ readonly success: boolean }>;
}
