// Plan mode cards — the plan delivery card and the two plan decisions.
//
// The runtime raises plan mode on the same questionnaire channel as every other
// interaction, and the request is recognised by `mode: "plan"` (see
// `projection/plan-mode.ts`). The desktop renders three distinct surfaces for
// that channel and so does this file:
//
//   * `plan-enter-confirmation`  — asked before plan mode starts.
//   * `plan-delivery-card`       — the plan file itself: title, preview of the
//                                  file body, and 执行 / 预览.
//   * `plan-review-decision`     — "计划完成，实施计划？" with the three-way
//                                  decision.
//
// The `data-testid` values are the desktop's own, so the same selectors work
// against either client. Prose and structure mirror the desktop chunk; the
// one deliberate difference is 预览, which expands the plan in place — the
// desktop opens the file in its preview panel, and the composer has no route
// into that panel to hand the path to.

import { useEffect, useLayoutEffect, useRef, useState, type ReactElement } from "react";
import {
  WEBUI_PLAN_COPY,
  buildWebuiPlanApproveAnswers,
  buildWebuiPlanEnterAnswers,
  buildWebuiPlanFeedbackAnswers,
  buildWebuiPlanSkipAnswers,
  isWebuiPlanReviewRequest,
  webuiPlanEnterOptions,
  webuiPlanMarkdown,
  webuiPlanReviewDescription,
  webuiPlanSummary,
  webuiPlanTitle,
} from "../projection/plan-mode.js";
import { WebuiMarkdown } from "../markdown.js";
import {
  WebuiIconClose,
  WebuiIconCommandPlan,
  WebuiIconMessageEdit,
} from "../icons.js";
import type {
  WebuiQuestionnaireAnswer,
  WebuiQuestionnaireRequest,
} from "../../shared/contracts/interactions.js";

/** Eye glyph for 预览. The desktop ships this one inside a per-chunk icon
 *  module whose path data is not addressable offline; this is an equivalent
 *  outline eye at the same 18px box. */
function PlanEyeIcon({ className }: { readonly className?: string }): ReactElement {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" fill="none" aria-hidden="true" className={className}>
      <path
        d="M2.25 9s2.5-4.25 6.75-4.25S15.75 9 15.75 9s-2.5 4.25-6.75 4.25S2.25 9 2.25 9Z"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinejoin="round"
      />
      <circle cx="9" cy="9" r="1.9" stroke="currentColor" strokeWidth="1.3" />
    </svg>
  );
}

/** Shared busy/error plumbing for every plan surface. */
interface WebuiPlanCardChrome {
  readonly busy?: boolean;
  readonly error?: string;
}

function PlanCardError({ error }: { readonly error?: string }): ReactElement | null {
  if (!error) return null;
  return (
    <p className="webui-plan-card-error" role="alert">
      {error}
    </p>
  );
}

/**
 * The plan file card: title, an always-visible preview of the plan's summary
 * section, and the two actions. The preview is capped and fades out at the
 * bottom edge the way the desktop's masked summary does, and 预览 expands the
 * whole file in place.
 */
export function WebuiPlanDeliveryCard({
  request,
  onBuild,
  onViewPlan,
  chrome,
}: {
  readonly request: WebuiQuestionnaireRequest;
  readonly onBuild: () => void;
  /** Open the whole plan file in the workspace panel. */
  readonly onViewPlan?: () => void;
  readonly chrome?: WebuiPlanCardChrome;
}): ReactElement {
  const markdown = webuiPlanMarkdown(request);
  const summary = webuiPlanSummary(markdown);
  const title = webuiPlanTitle(markdown) || WEBUI_PLAN_COPY.deliveryTitle;
  const description = webuiPlanReviewDescription(request);
  const busy = chrome?.busy === true;
  const [truncated, setTruncated] = useState(false);
  const contentRef = useRef<HTMLDivElement | null>(null);
  const summaryRef = useRef<HTMLDivElement | null>(null);

  // The summary is scrollable only when it actually overflows its cap, which
  // the stylesheet owns — read it off the element rather than repeating the
  // number here, since a copy that drifts reports the wrong flag.
  useLayoutEffect(() => {
    const element = contentRef.current;
    const box = summaryRef.current;
    if (!element) return undefined;
    const measure = () => {
      const cap = box ? Number.parseFloat(getComputedStyle(box).maxHeight) : Number.POSITIVE_INFINITY;
      if (!Number.isFinite(cap)) return;
      setTruncated(element.scrollHeight + 24 > cap);
    };
    measure();
    if (typeof ResizeObserver === "undefined") return undefined;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    if (summaryRef.current) observer.observe(summaryRef.current);
    return () => observer.disconnect();
  }, [summary]);

  return (
    <section
      className="webui-plan-delivery-card"
      data-testid="plan-delivery-card"
      data-request-id={request.id}
    >
      <div className="webui-plan-delivery-header" data-testid="plan-delivery-header">
        <div className="webui-plan-delivery-heading">
          <div className="webui-plan-delivery-icon" data-testid="plan-delivery-icon" aria-hidden="true">
            <WebuiIconCommandPlan className="size-full" />
          </div>
          <div className="webui-plan-delivery-heading-text">
            <h4 className="webui-plan-delivery-title" data-testid="plan-delivery-title" title={title}>
              {title}
            </h4>
            {description ? (
              <p className="webui-plan-review-description" data-testid="plan-review-description" role="status">
                {description}
              </p>
            ) : null}
          </div>
        </div>
        <div className="webui-plan-delivery-actions">
          <button
            type="button"
            className="webui-plan-build-button"
            data-testid="plan-build"
            disabled={busy}
            onClick={onBuild}
          >
            <span data-testid="plan-build-label">{WEBUI_PLAN_COPY.deliveryBuild}</span>
          </button>
          <button
            type="button"
            className="webui-plan-view-button"
            data-testid="plan-view"
            disabled={!onViewPlan}
            onClick={() => onViewPlan?.()}
          >
            <span className="webui-plan-view-icon" data-testid="plan-view-icon" aria-hidden="true">
              <PlanEyeIcon />
            </span>
            {/* The label stays 预览 whether or not the preview is open — the
                desktop's view button reads the same either way, and switching
                it to 执行 would duplicate the build action sitting next to it.
                Open state is carried by aria-exppressed semantics. */}
            <span data-testid="plan-view-label">{WEBUI_PLAN_COPY.deliveryView}</span>
          </button>
        </div>
      </div>

      {summary ? (
        <div
          className="webui-plan-delivery-summary"
          data-testid="plan-delivery-summary"
          data-summary-truncated={truncated ? "true" : "false"}
          ref={summaryRef}
        >
          <div className="webui-plan-delivery-summary-content" data-testid="plan-delivery-summary-content" ref={contentRef}>
            <WebuiMarkdown source={summary} />
          </div>
        </div>
      ) : null}

      <PlanCardError error={chrome?.error} />
    </section>
  );
}

/**
 * "计划完成，实施计划？" — approve, ask for changes, or skip. The free-text row
 * swaps its 跳过 button for 发送 as soon as there is something to send, which
 * is what makes the two states mutually exclusive on the desktop.
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
        <button
          type="button"
          className="webui-plan-review-close"
          data-testid="plan-review-close"
          aria-label="common.close"
          disabled={busy}
          onClick={() => submit(buildWebuiPlanSkipAnswers())}
        >
          <WebuiIconClose className="size-full" />
        </button>
      </header>
      <div className="webui-plan-review-body">
        <button
          type="button"
          className="webui-plan-review-approve"
          data-testid="plan-review-approve"
          disabled={busy}
          onClick={() => submit(buildWebuiPlanApproveAnswers())}
        >
          <span className="webui-plan-review-approve-badge" aria-hidden="true">A</span>
          <span className="webui-plan-review-approve-label">{WEBUI_PLAN_COPY.reviewApprove}</span>
        </button>
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
            <input
              type="text"
              className="webui-plan-review-feedback-input"
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
              <button
                type="button"
                className="webui-plan-review-feedback-submit"
                data-testid="plan-review-feedback-submit"
                disabled={busy}
                onClick={() => submit(buildWebuiPlanFeedbackAnswers(trimmed))}
              >
                {WEBUI_PLAN_COPY.send}
              </button>
            ) : (
              <button
                type="button"
                className="webui-plan-review-skip"
                data-testid="plan-review-skip"
                disabled={busy}
                onClick={() => submit(buildWebuiPlanSkipAnswers())}
              >
                {WEBUI_PLAN_COPY.skip}
              </button>
            )}
          </div>
        </div>
      </div>
      <PlanCardError error={chrome?.error} />
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
    <section
      className="webui-plan-enter-confirmation"
      data-testid="plan-enter-confirmation"
      data-request-id={request.id}
    >
      <div className="webui-plan-enter-body">
        <h4 className="webui-plan-enter-title">{WEBUI_PLAN_COPY.enterTitle}</h4>
        <p className="webui-plan-enter-description">{WEBUI_PLAN_COPY.enterDescription}</p>
        <div className="webui-plan-enter-actions">
          {options.decline ? (
            <button
              type="button"
              className="webui-plan-enter-button"
              data-testid="plan-enter-decline"
              disabled={busy}
              onClick={() => onAnswers(buildWebuiPlanEnterAnswers("decline"))}
            >
              {WEBUI_PLAN_COPY.enterDecline}
            </button>
          ) : null}
          {options.confirm ? (
            <button
              type="button"
              className="webui-plan-enter-confirm"
              data-testid="plan-enter-confirm"
              disabled={busy}
              onClick={() => onAnswers(buildWebuiPlanEnterAnswers("confirm"))}
            >
              {WEBUI_PLAN_COPY.enterConfirm}
            </button>
          ) : null}
        </div>
      </div>
      <PlanCardError error={chrome?.error} />
    </section>
  );
}

/**
 * Desktop's plan dispatch in one place: a plan request that already carries the
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
