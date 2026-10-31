// Plan mode — pure projections for the plan request the runtime asks the user
// to decide on.
//
// The runtime raises ONE questionnaire channel for plan mode. A plan request
// carries `mode: "plan"` and, once the agent has written the plan file, a
// `modePayload.planReview` holding that file's markdown and absolute path.
// The generic questionnaire panel cannot render it: plan mode needs a plan
// card with a preview of the file plus a three-way decision (implement /
// adjust / skip), and its answers are `plan-review` step answers rather than
// option selections.
//
// Everything here is a pure function of the request so the parsing rules — the
// title heading, the summary extraction, the three answer payloads — are
// asserted directly instead of through a rendered card. The notes on each
// function below state the behaviour it implements.

import type {
  WebuiQuestionnaireAnswer,
  WebuiQuestionnaireRequest,
} from "../../../../shared/contracts/interactions.js";

/** The step id the runtime uses for the post-plan decision. The
 *  approve / feedback / skip payloads all answer this step. */
export const WEBUI_PLAN_REVIEW_STEP_ID = "plan-review";

/** The step id the runtime uses when asking to enter plan mode at all. */
export const WEBUI_PLAN_ENTER_STEP_ID = "plan-enter";

const PLAN_REVIEW_APPROVE_OPTION_ID = "approve";
const PLAN_ENTER_CONFIRM_OPTION_ID = "confirm";
const PLAN_ENTER_DECLINE_OPTION_ID = "decline";

/** zh copy for the plan cards. */
export const WEBUI_PLAN_COPY = {
  enterTitle: "使用计划模式？",
  enterDescription: "计划模式会在执行前先梳理复杂任务。",
  enterConfirm: "继续制定计划",
  enterDecline: "拒绝",
  reviewTitle: "计划完成，实施计划？",
  reviewApprove: "是，实施计划",
  reviewFeedbackPlaceholder: "否，告诉MiniMax Code 如何调整...",
  deliveryTitle: "计划",
  deliveryBuild: "执行",
  deliveryView: "预览",
  skip: "跳过",
  send: "发送",
} as const;



/** A plan request that has NOT reached a written file — the runtime asking
 *  permission to enter plan mode at all. The complement of
 *  `isWebuiPlanReviewRequest` within plan mode. */
export function isWebuiPlanEnterRequest(
  request: WebuiQuestionnaireRequest | undefined,
): boolean {
  return isWebuiPlanRequest(request) && request?.modePayload?.planReview === undefined;
}



/** The warning line shown under the plan title, taken from the
 *  `plan-review` step's description. */
export function webuiPlanReviewDescription(
  request: WebuiQuestionnaireRequest | undefined,
): string {
  return request?.steps.find((step) => step.id === WEBUI_PLAN_REVIEW_STEP_ID)
    ?.description?.trim() ?? "";
}

/** `plan-enter` declares which of confirm/decline this runtime build offers;
 *  a button whose option is absent is hidden. */
export function webuiPlanEnterOptions(
  request: WebuiQuestionnaireRequest | undefined,
): { readonly confirm: boolean; readonly decline: boolean } {
  const options = request?.steps.find(
    (step) => step.id === WEBUI_PLAN_ENTER_STEP_ID,
  )?.options;
  const ids = (options ?? []).map((option) => option.id);
  return {
    confirm: options === undefined || ids.includes(PLAN_ENTER_CONFIRM_OPTION_ID),
    decline: options === undefined || ids.includes(PLAN_ENTER_DECLINE_OPTION_ID),
  };
}

interface WebuiMarkdownHeading {
  readonly level: number;
  readonly text: string;
}

/** ATX heading: `/^ {0,3}(#{1,6})[\t ]+(.+?)[\t ]*#*[\t ]*$/u`. */
function parseHeading(line: string): WebuiMarkdownHeading | undefined {
  const match = /^ {0,3}(#{1,6})[\t ]+(.+?)[\t ]*#*[\t ]*$/u.exec(line);
  return match?.[1] && match[2]
    ? { level: match[1].length, text: match[2].trim() }
    : undefined;
}

/** Fence opener: `/^ {0,3}(`{3,}|~{3,})/u`. */
function parseFence(line: string): { readonly marker: string; readonly length: number } | undefined {
  const match = /^ {0,3}(`{3,}|~{3,})/u.exec(line);
  const marker = match?.[1];
  return marker ? { marker: marker[0] ?? "", length: marker.length } : undefined;
}

/** The plan's title: the first level-1 heading OUTSIDE a fenced code block.
 *  Headings inside fences are skipped rather than closing the fence, so a
 *  ```# not a heading``` block is ignored. */
export function webuiPlanTitle(markdown: string): string {
  const lines = markdown.replace(/\r\n?/gu, "\n").split("\n");
  let open: { readonly marker: string; readonly length: number } | undefined;
  for (const line of lines) {
    const fence = parseFence(line);
    if (fence) {
      open
        ? fence.marker === open.marker && fence.length >= open.length && (open = undefined)
        : (open = fence);
      continue;
    }
    if (open) continue;
    const heading = parseHeading(line);
    if (heading?.level === 1) return heading.text;
  }
  return "";
}

/**
 * The plan's one-screen summary.
 *
 * The extractor looks for a heading whose text is `summary` (case-insensitive),
 * then keeps every following line until the next heading at that heading's own
 * level or shallower — so a plan written as `# Title` / `## Summary` / body /
 * `## 画布与调色板` previews the body of the Summary section. Fenced blocks are
 * carried through intact rather than cut at a `#` inside them.
 *
 * With no Summary heading it falls back to the first non-empty line that is
 * neither a heading nor inside a fence, which keeps a heading-only plan from
 * rendering an empty card.
 */
export function webuiPlanSummary(markdown: string): string {
  const lines = markdown.replace(/\r\n?/gu, "\n").split("\n");
  let open: { readonly marker: string; readonly length: number } | undefined;
  let summaryIndex = -1;
  let summaryLevel = 6;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    const fence = parseFence(line);
    if (fence) {
      open
        ? fence.marker === open.marker && fence.length >= open.length && (open = undefined)
        : (open = fence);
      continue;
    }
    if (open) continue;
    const heading = parseHeading(line);
    if (heading?.text.toLowerCase() === "summary") {
      summaryIndex = index;
      summaryLevel = heading.level;
      break;
    }
  }

  if (summaryIndex >= 0) {
    const collected: string[] = [];
    open = undefined;
    for (let index = summaryIndex + 1; index < lines.length; index += 1) {
      const line = lines[index] ?? "";
      const fence = parseFence(line);
      if (fence) {
        open
          ? fence.marker === open.marker && fence.length >= open.length && (open = undefined)
          : (open = fence);
        collected.push(line);
        continue;
      }
      const heading = open ? undefined : parseHeading(line);
      if (heading && heading.level <= summaryLevel) break;
      collected.push(line);
    }
    return collected.join("\n").trim();
  }

  open = undefined;
  for (const line of lines) {
    const fence = parseFence(line);
    if (fence) {
      open
        ? fence.marker === open.marker && fence.length >= open.length && (open = undefined)
        : (open = fence);
      continue;
    }
    if (open) continue;
    if (line.trim().length > 0 && !parseHeading(line)) return line.trim();
  }
  return "";
}

/**
 * The three decision payloads. Each answers the `plan-review` step and is
 * posted through the ordinary questionnaire reply channel — the runtime
 * already dispatches plan answers from `questionnaire-action-handler.ts`, so
 * these must keep the runtime's wire shape rather than invent a new one.
 */

/** "是，实施计划" — approve the plan and let the agent execute it. */
export function buildWebuiPlanApproveAnswers(): readonly WebuiQuestionnaireAnswer[] {
  return [
    {
      stepId: WEBUI_PLAN_REVIEW_STEP_ID,
      selectedOptionIds: [PLAN_REVIEW_APPROVE_OPTION_ID],
      selectedOther: false,
    },
  ];
}

/** The free-text row — submit it to ask for changes instead of implementing. */
export function buildWebuiPlanFeedbackAnswers(
  feedback: string,
): readonly WebuiQuestionnaireAnswer[] {
  return [
    {
      stepId: WEBUI_PLAN_REVIEW_STEP_ID,
      selectedOptionIds: [],
      selectedOther: true,
      otherText: feedback.trim(),
    },
  ];
}

/** "跳过" — dismiss the decision and leave the plan unbuilt. */
export function buildWebuiPlanSkipAnswers(): readonly WebuiQuestionnaireAnswer[] {
  return [
    {
      stepId: WEBUI_PLAN_REVIEW_STEP_ID,
      selectedOptionIds: [],
      selectedOther: false,
      skipped: true,
    },
  ];
}

/** The entry confirmation posts against the `plan-enter` step, echoing the
 *  clicked option id back. */
export function buildWebuiPlanEnterAnswers(
  optionId: typeof PLAN_ENTER_CONFIRM_OPTION_ID | typeof PLAN_ENTER_DECLINE_OPTION_ID,
): readonly WebuiQuestionnaireAnswer[] {
  return [
    {
      stepId: WEBUI_PLAN_ENTER_STEP_ID,
      selectedOptionIds: [optionId],
      selectedOther: false,
    },
  ];
}

// The published derivations (see `contracts/interactions/plan-mode.ts`), re-exported
// for the surfaces that already read them from this module. They are
// re-exported here for the surfaces that already read them from this module; a
// consumer outside the interactions business reads the contract.
import { isWebuiPlanRequest } from "../contracts/plan-mode.js";

export {
  isWebuiPlanRequest,
  isWebuiPlanReviewRequest,
  webuiPlanMarkdown,
  webuiPlanPath,
} from "../contracts/plan-mode.js";
