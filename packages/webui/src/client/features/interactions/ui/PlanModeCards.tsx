// Plan mode cards — the plan enter/decision surfaces that stay private to the
// interactions business.
//
// The transcript business consumes only `WebuiPlanDeliveryCard` (the response
// surface of a plan turn), and that card is published as
// `./PlanModeCards.public.tsx`. The two surfaces the interactions business
// owns internally — `WebuiPlanReviewDecision` and `WebuiPlanEnterConfirmation`
// — and the dispatch that picks between them (`WebuiPlanSurface`) sit here,
// because no other screen mounts them.
//
// The shared `WebuiPlanCardChrome` is a published type: it has to be the
// private surface's contract for the chrome the public card carries, so the
// private file imports it from the publication marker rather than redeclaring
// it.

import { useEffect, useState, type ReactElement } from "react";
import { FeedbackError } from "../../../ui/feedback.js";
import { WebuiTextInput } from "../../../ui/field.js";
import { WebuiButton, WebuiIconButton } from "../../../ui/button.js";
import { WebuiStack } from "../../../ui/layout-primitives.js";

import {
  WEBUI_PLAN_COPY,
  buildWebuiPlanApproveAnswers,
  buildWebuiPlanEnterAnswers,
  buildWebuiPlanFeedbackAnswers,
  buildWebuiPlanSkipAnswers,
  isWebuiPlanReviewRequest,
  webuiPlanEnterOptions,
} from "../projection/plan-mode.js";
import {
  WebuiIconClose,
  WebuiIconMessageEdit,
} from "../../../shell/icons.js";
import type {
  WebuiQuestionnaireAnswer,
  WebuiQuestionnaireRequest,
} from "../../../../shared/contracts/interactions.js";
import {
  WebuiPlanDeliveryCard,
  type WebuiPlanCardChrome,
} from "./PlanModeCards.public.js";

// `WebuiPlanDeliveryCard` lives in the published sibling so the transcript
// business reads the plan-delivery UI through the publication marker. The
// private plan surfaces still live here; the test file asserts them through
// this module.
//
// `WebuiPlanCardChrome` is exported for the public surface (`.public.tsx`)
// to declare its prop. The interaction's own consumers do not name it
// directly, so it is imported here purely for the published card's contract.

export { WebuiPlanDeliveryCard, type WebuiPlanCardChrome };

/**
 * "计划完成，实施计划？" — approve, ask for changes, or skip. The free-text row
 * swaps its 跳过 button for 发送 as soon as there is something to send, which
 * is what makes the two states mutually exclusive.
 */
export function WebuiPlanReviewDecision({
  request,
  onAnswers,
  chrome,
}: {
  readonly request: WebuiQuestionnaireRequest;
  readonly onAnswers: (answers: readonly WebuiQuestionnaireAnswer[]) => void;
  readonly chrome?: WebuiPlanCardChrome;
}): ReactElement {
  const [feedback, setFeedback] = useState("");
  const busy = chrome?.busy === true;
  const trimmed = feedback.trim();
  const hasFeedback = trimmed.length > 0;

  // A new request means a new decision; stale text must not carry across.
  useEffect(() => {
    setFeedback("");
  }, [request.id]);

  const submit = (answers: readonly WebuiQuestionnaireAnswer[]) => {
    if (busy) return;
    onAnswers(answers);
  };

  return (
    <section
      className="webui-plan-review-decision"
      data-testid="plan-review-decision"
      data-request-id={request.id}
    >
      <header className="webui-plan-review-header">
        <h4 className="webui-plan-review-title">{WEBUI_PLAN_COPY.reviewTitle}</h4>
        <WebuiIconButton
          tone="bare"
          className="webui-plan-review-close-size"
          label="common.close"
          data-testid="plan-review-close"
          disabled={busy}
          onClick={() => submit(buildWebuiPlanSkipAnswers())}
        >
          <WebuiIconClose className="h-full w-full" />
        </WebuiIconButton>
      </header>
      <div className="webui-plan-review-body">
        <WebuiButton
          variant="selectable-row"
          size="row"
          className="webui-plan-review-approve"
          data-testid="plan-review-approve"
          disabled={busy}
          onClick={() => submit(buildWebuiPlanApproveAnswers())}
        >
          <span className="webui-plan-review-approve-badge" aria-hidden="true">A</span>
          <span className="webui-plan-review-approve-label">{WEBUI_PLAN_COPY.reviewApprove}</span>
        </WebuiButton>
        <div
          className="webui-plan-review-feedback-option"
          data-testid="plan-review-feedback-option"
          data-selected={hasFeedback ? "true" : "false"}
        >
          <div className="webui-plan-review-feedback-row">
            <span
              className="webui-plan-review-feedback-icon"
              aria-hidden="true"
            >
              <WebuiIconMessageEdit size={16} />
            </span>
            <WebuiTextInput
              appearance="bare"
              className="min-w-0 flex-1"
              type="text"
              data-testid="plan-review-feedback-input"
              value={feedback}
              disabled={busy}
              placeholder={WEBUI_PLAN_COPY.reviewFeedbackPlaceholder}
              onChange={(event) => setFeedback(event.target.value)}
              onKeyDown={(event) => {
                // Enter submits, but never mid-composition: an IME candidate
                // window closes on Enter and would otherwise send a half-word.
                const native = event.nativeEvent as KeyboardEvent;
                if (
                  event.key !== "Enter" ||
                  native.isComposing ||
                  native.keyCode === 229
                )
                  return;
                if (!hasFeedback) return;
                event.preventDefault();
                event.stopPropagation();
                submit(buildWebuiPlanFeedbackAnswers(trimmed));
              }}
            />
            {hasFeedback ? (
              <WebuiButton
                variant="accent"
                size="inline-dense"
                className="min-w-[56px] shrink-0"
                data-testid="plan-review-feedback-submit"
                disabled={busy}
                onClick={() => submit(buildWebuiPlanFeedbackAnswers(trimmed))}
              >
                {WEBUI_PLAN_COPY.send}
              </WebuiButton>
            ) : (
              <WebuiButton
                variant="outline"
                size="inline-dense"
                className="min-w-[56px] shrink-0"
                data-testid="plan-review-skip"
                disabled={busy}
                onClick={() => submit(buildWebuiPlanSkipAnswers())}
              >
                {WEBUI_PLAN_COPY.skip}
              </WebuiButton>
            )}
          </div>
        </div>
      </div>
      {chrome?.error ? (
        <FeedbackError message={chrome.error} className="webui-plan-card-error" />
      ) : null}
    </section>
  );
}

/** Asked before plan mode starts; both buttons post against `plan-enter`. */
export function WebuiPlanEnterConfirmation({
  request,
  onAnswers,
  chrome,
}: {
  readonly request: WebuiQuestionnaireRequest;
  readonly onAnswers: (answers: readonly WebuiQuestionnaireAnswer[]) => void;
  readonly chrome?: WebuiPlanCardChrome;
}): ReactElement {
  const busy = chrome?.busy === true;
  const options = webuiPlanEnterOptions(request);
  return (
    <WebuiStack
      as="section"
      gap="small"
      className="webui-plan-enter-confirmation"
      data-testid="plan-enter-confirmation"
      data-request-id={request.id}
    >
      <div className="webui-plan-enter-body">
        <h4 className="webui-plan-enter-title">{WEBUI_PLAN_COPY.enterTitle}</h4>
        <p className="webui-plan-enter-description">{WEBUI_PLAN_COPY.enterDescription}</p>
        <div className="webui-plan-enter-actions">
          {options.decline ? (
            <WebuiButton
              variant="outline"
              size="inline-dense"
              data-testid="plan-enter-decline"
              disabled={busy}
              onClick={() => onAnswers(buildWebuiPlanEnterAnswers("decline"))}
            >
              {WEBUI_PLAN_COPY.enterDecline}
            </WebuiButton>
          ) : null}
          {options.confirm ? (
            <WebuiButton
              variant="accent"
              size="inline-dense"
              data-testid="plan-enter-confirm"
              disabled={busy}
              onClick={() => onAnswers(buildWebuiPlanEnterAnswers("confirm"))}
            >
              {WEBUI_PLAN_COPY.enterConfirm}
            </WebuiButton>
          ) : null}
        </div>
      </div>
      {chrome?.error ? (
        <FeedbackError message={chrome.error} className="webui-plan-card-error" />
      ) : null}
    </WebuiStack>
  );
}

/**
 * The plan dispatch in one place: a plan request that already carries the
 * written file is the decision card, and a plan request without it is the entry
 * confirmation. Anything else is not ours and renders nothing.
 */
export function WebuiPlanSurface({
  request,
  onAnswers,
  chrome,
}: {
  readonly request: WebuiQuestionnaireRequest | undefined;
  readonly onAnswers: (answers: readonly WebuiQuestionnaireAnswer[]) => void;
  readonly chrome?: WebuiPlanCardChrome;
}): ReactElement | null {
  if (!request || request.mode !== "plan") return null;
  return isWebuiPlanReviewRequest(request) ? (
    <WebuiPlanReviewDecision request={request} onAnswers={onAnswers} chrome={chrome} />
  ) : (
    <WebuiPlanEnterConfirmation request={request} onAnswers={onAnswers} chrome={chrome} />
  );
}
