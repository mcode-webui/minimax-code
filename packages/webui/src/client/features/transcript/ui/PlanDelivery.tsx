// The transcript's plan-delivery response surface: the card the transcript renders
// as the footer of the turn that wrote a plan, and the two commands it offers
// (build, view).
//
// Cut out of `SessionTranscript.tsx` with the submitting/error state that
// belongs to those commands. The transcript still decides *whether* a plan card
// belongs in the message column — that read is composition, and the composer
// keeps its own copy for the decision — but the response itself, and what it
// does when asked, is here.

import { useCallback, useState, type ReactElement } from "react";

import type { WebuiQuestionnaireRequest } from "../../../../shared/contracts/interactions.js";
import { webuiPlanMarkdown, webuiPlanPath } from "../../interactions/contracts/plan-mode.js";
import { WebuiPlanDeliveryCard } from "../../interactions/ui/PlanModeCards.public.js";

export function WebuiTranscriptPlanDelivery({
  sessionId,
  request,
  answerPlanBuild,
  onOpenPlanFile,
}: {
  readonly sessionId: string;
  readonly request: WebuiQuestionnaireRequest;
  readonly answerPlanBuild?: (request: WebuiQuestionnaireRequest) => Promise<void>;
  readonly onOpenPlanFile?: (input: {
    readonly sessionId: string;
    readonly path: string;
    readonly content: string;
  }) => void;
}): ReactElement {
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const submit = useCallback(() => {
    if (!answerPlanBuild) return;
    setError(undefined);
    setSubmitting(true);
    void answerPlanBuild(request)
      .catch((reason: unknown) => {
        setError(reason instanceof Error ? reason.message : String(reason));
      })
      .finally(() => setSubmitting(false));
  }, [answerPlanBuild, request]);
  // 预览 opens the whole plan file in the workspace panel. The file lives
  // outside the workspace
  // root, so the content travels with the command instead of being read back.
  const viewPlan = useCallback(() => {
    const path = webuiPlanPath(request);
    if (!path || !onOpenPlanFile) return;
    onOpenPlanFile({ sessionId, path, content: webuiPlanMarkdown(request) });
  }, [onOpenPlanFile, request, sessionId]);
  return (
    <WebuiPlanDeliveryCard
      request={request}
      onBuild={submit}
      onViewPlan={viewPlan}
      chrome={{ busy: submitting, error }}
    />
  );
}
