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
