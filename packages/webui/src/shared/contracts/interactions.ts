// Wire contract record (plan section 7.1 / 7.5): every exported
// declaration below records its wire purpose, its producer and its
// consumers, verified against the tree. Documentation only.
//
// | Declaration | Wire purpose | Producer | Consumers |
// | --- | --- | --- | --- |
// | `WebuiPendingPermission` | One pending tool-permission request. | Runtime `listPendingPermissions` (`runtime/harness/interactions.ts`; CliService). | `client/contracts/interaction-port.ts`; `client/projection/effect-reducer.ts`; `client/components/InteractionPanel.tsx`. |
// | `WebuiQuestionnaireOption` | One selectable option in a questionnaire step. | Runtime `getPendingQuestionnaire` (`runtime/harness/interactions.ts`). | `client/projection/questionnaire-state.ts`. |
// | `WebuiQuestionnaireStep` | One question/step of a questionnaire. | Runtime `getPendingQuestionnaire`. | `client/projection/questionnaire-state.ts`. |
// | `WebuiQuestionnaireRequest` | The pending questionnaire (steps, presentation, plan-review payload). | Runtime `getPendingQuestionnaire`. | `client/contracts/interaction-port.ts`; `client/projection/questionnaire-state.ts`; `client/components/InteractionPanel.tsx`; `server/operation/questionnaire.ts`. |
// | `WebuiQuestionnaireAnswer` | One submitted answer to a questionnaire step. | Browser `client/components/InteractionPanel.tsx` / `client/transport.ts` (`replyQuestionnaire`). | `client/contracts/interaction-port.ts`; runtime `replyQuestionnaire`; `server/operation/questionnaire.ts`. |
// | `WebuiPermissionDecision` | The allowOnce/allowAlways/deny reply value. | Browser `client/components/InteractionPanel.tsx`. | Runtime `permissionReplyValue` (`runtime/harness/interactions.ts`); `server/operation/common.ts`. |
// | `WebuiInteractionReplyResult` | Outcome of a permission/questionnaire reply or dismissal. | Runtime `replyPermission`/`replyQuestionnaire`/`dismissQuestionnaire` (`runtime/harness/interactions.ts`); `server/operation/questionnaire.ts`. | `client/contracts/interaction-port.ts`; `client/transport.ts`; `client/components/SessionComposer.tsx`. |
export interface WebuiPendingPermission {
  readonly requestId: string;
  readonly sessionId: string;
  readonly agentName: string;
  readonly toolName: string;
  readonly ruleContents: readonly string[];
  readonly toolInput?: string;
  readonly toolDescription?: string;
  readonly reason: string;
  readonly allowAlwaysSupported: boolean;
  readonly createdAt: number;
}

export interface WebuiQuestionnaireOption {
  readonly id: string;
  readonly label: string;
  readonly description?: string;
  readonly recommended?: boolean;
}

export interface WebuiQuestionnaireStep {
  readonly id: string;
  readonly header?: string;
  readonly question: string;
  readonly description?: string;
  readonly selectionMode: number;
  readonly options?: readonly WebuiQuestionnaireOption[];
  readonly allowOther: boolean;
  readonly otherPlaceholder: string;
  readonly required: boolean;
}

export interface WebuiQuestionnaireRequest {
  readonly schemaVersion: number;
  readonly id: string;
  readonly title?: string;
  readonly requester?: {
    readonly sessionId: string;
    readonly runId?: string;
    readonly toolCallId?: string;
    readonly agentName?: string;
  };
  readonly presentation: {
    readonly replaceComposer: boolean;
    readonly showProgress: boolean;
    readonly allowBackNavigation: boolean;
  };
  readonly steps: readonly WebuiQuestionnaireStep[];
  readonly expiresAt?: number;
  readonly status?: number;
  readonly createdAt?: number;
  readonly mode?: string;
  readonly purpose?: number;
  /**
   * The message that raised this request. The plan card is rendered as a
   * message in the transcript, so it needs the id of the turn message to
   * anchor itself to — the desktop attaches it as that message's footer.
   */
  readonly tool?: {
    readonly messageId: string;
    readonly callId: string;
  };
  /**
   * Mode-specific request body. The runtime attaches the plan file to a plan
   * request so the plan card can render its own preview and decision UI
   * instead of the generic questionnaire. `cli-service.ts` copies
   * `planReview` through verbatim, so it is already on the wire.
   */
  readonly modePayload?: {
    readonly featureKey?: string;
    readonly planReview?: {
      readonly markdown: string;
      readonly path: string;
    };
  };
}

export interface WebuiQuestionnaireAnswer {
  readonly stepId: string;
  readonly selectedOptionIds?: readonly string[];
  readonly selectedOther?: boolean;
  readonly otherText?: string;
  readonly skipped?: boolean;
}

export type WebuiPermissionDecision = "allowOnce" | "allowAlways" | "deny";

export interface WebuiInteractionReplyResult {
  readonly success?: boolean;
  readonly ok?: boolean;
  readonly requestId?: string;
  readonly sessionId?: string;
  readonly answeredAt?: number;
  readonly dismissedAt?: number;
}
