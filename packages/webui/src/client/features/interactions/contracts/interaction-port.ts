// Interaction capability port.
//
// The pending interactions: the permission list and its reply, the questionnaire
// read, reply and dismissal. The goal entity and its version fence are a separate
// port, `features/goal/contracts/goal-port.ts`.
//
// Every method stays optional — `undefined` means "the operation is not wired".

import type { WebuiInteractionReplyResult, WebuiPendingPermission, WebuiQuestionnaireAnswer, WebuiQuestionnaireRequest } from "../../../../shared/contracts/interactions.js";

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
}
