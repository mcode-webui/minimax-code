// The plan request's published derivations: the transcript and the composer both
// read whether a pending request is a plan review, and the file the plan was
// written to. They are pure functions of the published questionnaire payload,
// declared here so a consumer reads them from the interactions business instead
// of from the projection that renders them.

import type { WebuiQuestionnaireRequest } from "../../../../shared/contracts/interactions.js";

/** Whether this request is a plan-mode request at all. Every plan surface
 *  gates on the same predicate (`mode === "plan"`). */
export function isWebuiPlanRequest(
  request: WebuiQuestionnaireRequest | undefined,
): boolean {
  return request?.mode === "plan";
}

/** A plan request that already carries the written plan file — the
 *  `planReview` case. It selects the decision card over the entry
 *  confirmation. */
export function isWebuiPlanReviewRequest(
  request: WebuiQuestionnaireRequest | undefined,
): boolean {
  return isWebuiPlanRequest(request) && request?.modePayload?.planReview !== undefined;
}

/** The plan markdown, or "" when the request has not reached the file yet. */
export function webuiPlanMarkdown(
  request: WebuiQuestionnaireRequest | undefined,
): string {
  return request?.modePayload?.planReview?.markdown ?? "";
}

/** The plan file's absolute path, or undefined. */
export function webuiPlanPath(
  request: WebuiQuestionnaireRequest | undefined,
): string | undefined {
  const path = request?.modePayload?.planReview?.path;
  return path === undefined || !path.trim() ? undefined : path;
}
