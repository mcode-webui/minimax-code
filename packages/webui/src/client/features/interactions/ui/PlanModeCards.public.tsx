// The interactions business's published plan-delivery card.
//
// The transcript renders this card as the response surface of a plan turn: every
// peer that needs the plan-decision UI goes through the card the interactions
// business owns. The rest of the plan surfaces (`plan-enter-confirmation`,
// `plan-review-decision`, and the dispatch that picks between them) stay
// private to the interactions business because no other screen mounts them.
//
// This module is `.public` because the transcript business needs to render the
// plan-delivery UI as the response surface of a plan turn. The `.public` suffix
// is a publication marker; the card and what it renders are unchanged, and the
// rest of the plan surface stays in the private sibling `PlanModeCards.tsx`.

import { useLayoutEffect, useRef, useState, type ReactElement } from "react";
import { IconEye } from "@tabler/icons-react";

import {
  WEBUI_PLAN_COPY,
  webuiPlanMarkdown,
  webuiPlanReviewDescription,
  webuiPlanSummary,
  webuiPlanTitle,
} from "../projection/plan-mode.js";
import { WebuiMarkdown } from "../../transcript/ui/markdown.public.js";
import {
  WebuiIconCommandPlan,
} from "../../../shell/icons.js";
import type {
  WebuiQuestionnaireRequest,
} from "../../../../shared/contracts/interactions.js";
import { FeedbackError } from "../../../ui/feedback.js";

/** Shared busy/error plumbing for every plan surface. */
export interface WebuiPlanCardChrome {
  readonly busy?: boolean;
  readonly error?: string;
}

function PlanCardError({ error }: { readonly error?: string }): ReactElement | null {
  if (!error) return null;
  return (
    <FeedbackError message={error} className="webui-plan-card-error" />
  );
}

/**
 * The plan file card: title, an always-visible preview of the plan's summary
 * section, and the two actions. The preview is capped and fades out at the
 * bottom edge under a mask, and 预览 expands the whole file in place.
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
            <WebuiIconCommandPlan className="h-full w-full" />
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
                view button reads the same either way, and switching
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

/** Eye glyph for 预览: an outline eye in an 18px box. */
function PlanEyeIcon({ className }: { readonly className?: string }): ReactElement {
  return <IconEye aria-hidden="true" className={className} size={18} stroke={1.7} />;
}
