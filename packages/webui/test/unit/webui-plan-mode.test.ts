// Plan mode — pure projections and SSR branches.
//
// Two shapes, applied to the same feature (see the skill's testing rule):
//
//   1. The parsing and payload rules live in `projection/plan-mode.ts` as pure
//      functions, so the title/summary extraction and the three answer payloads
//      are asserted directly, including the fence handling that a rendered card
//      cannot distinguish.
//   2. The cards are asserted through `renderToStaticMarkup` across every render
//      branch — the delivery card, the decision card's two input states, the
//      entry confirmation, and the dispatch that picks between them.
//
// What SSR cannot reach is stated rather than implied: nothing here proves a
// click arrives at the submit handler, and nothing here drives the real
// runtime. Those boundaries are in the change report.

import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { webuiAnswersEndTurn } from "../../src/client/projection/questionnaire-state.js";
import {
  buildWebuiPlanApproveAnswers,
  buildWebuiPlanEnterAnswers,
  buildWebuiPlanFeedbackAnswers,
  buildWebuiPlanSkipAnswers,
  isWebuiPlanEnterRequest,
  isWebuiPlanReviewRequest,
  webuiPlanEnterOptions,
  webuiPlanMarkdown,
  webuiPlanPath,
  webuiPlanReviewDescription,
  webuiPlanSummary,
  webuiPlanTitle,
  WEBUI_PLAN_REVIEW_STEP_ID,
} from "../../src/client/projection/plan-mode.js";
import {
  WebuiPlanDeliveryCard,
  WebuiPlanEnterConfirmation,
  WebuiPlanReviewDecision,
  WebuiPlanSurface,
} from "../../src/client/components/PlanModeCards.js";
import { WebuiInteractionPanel } from "../../src/client/components/InteractionPanel.js";
import type {
  WebuiQuestionnaireRequest,
  WebuiQuestionnaireStep,
} from "../../src/shared/contracts/interactions.js";

const PLAN_MARKDOWN = [
  "# 鹦鹉骑自行车 SVG",
  "",
  "## Summary",
  "",
  "交付一个自包含的静态 SVG 文件：扁平几何卡通风、透明背景。",
  "",
  "## 画布与调色板",
  "",
  "| 角色 | 色值 |",
  "|---|---|",
  "| ink | `#1F2D3D` |",
].join("\n");

function step(id: string, extra: Partial<WebuiQuestionnaireStep> = {}): WebuiQuestionnaireStep {
  return {
    id,
    question: "q",
    selectionMode: 0,
    allowOther: false,
    otherPlaceholder: "",
    required: false,
    ...extra,
  };
}

function planReviewRequest(
  overrides: Partial<WebuiQuestionnaireRequest> = {},
): WebuiQuestionnaireRequest {
  return {
    schemaVersion: 2,
    id: "ask_plan_1",
    // Mirrors the real wire shape: the runtime defaults every ordinary
    // questionnaire — the plan review included — to replacing the composer.
    presentation: {
      replaceComposer: true,
      showProgress: true,
      allowBackNavigation: true,
    },
    steps: [step(WEBUI_PLAN_REVIEW_STEP_ID, { description: "已写好计划，确认后实施" })],
    mode: "plan",
    modePayload: {
      planReview: { markdown: PLAN_MARKDOWN, path: "/tmp/plan.md" },
    },
    ...overrides,
  };
}

describe("plan-mode projection", () => {
  it("recognises a plan request and a plan request that carries the file", () => {
    expect(isWebuiPlanReviewRequest(planReviewRequest())).toBe(true);
    expect(isWebuiPlanReviewRequest({ ...planReviewRequest(), mode: "questionnaire" })).toBe(false);
    // A plan request without a written file is the entry confirmation, not the
    // decision — the same distinction the desktop draws.
    expect(isWebuiPlanReviewRequest({ ...planReviewRequest(), modePayload: undefined })).toBe(false);
    expect(isWebuiPlanEnterRequest?.({ ...planReviewRequest(), modePayload: undefined })).toBe(true);
  });

  it("reads the markdown, the path and the warning description", () => {
    const request = planReviewRequest();
    expect(webuiPlanMarkdown(request)).toBe(PLAN_MARKDOWN);
    expect(webuiPlanPath(request)).toBe("/tmp/plan.md");
    expect(webuiPlanReviewDescription(request)).toBe("已写好计划，确认后实施");
  });

  it("treats a blank path as absent", () => {
    expect(webuiPlanPath({ ...planReviewRequest(), modePayload: { planReview: { markdown: "# x", path: "  " } } })).toBeUndefined();
  });

  it("takes the title from the first level-1 heading", () => {
    expect(webuiPlanTitle(PLAN_MARKDOWN)).toBe("鹦鹉骑自行车 SVG");
    expect(webuiPlanTitle("## 只有二级标题")).toBe("");
  });

  it("ignores a heading inside a fenced block", () => {
    const markdown = ["```md", "# 这是代码不是标题", "```", "", "# 真正的标题"].join("\n");
    expect(webuiPlanTitle(markdown)).toBe("真正的标题");
  });

  it("handles tilde fences and a longer closing fence", () => {
    const markdown = ["~~~", "# fenced", "~~~~", "", "# Real"].join("\n");
    expect(webuiPlanTitle(markdown)).toBe("Real");
  });

  it("previews the Summary section and stops at the next peer heading", () => {
    const summary = webuiPlanSummary(PLAN_MARKDOWN);
    expect(summary).toBe("交付一个自包含的静态 SVG 文件：扁平几何卡通风、透明背景。");
    expect(summary).not.toContain("画布与调色板");
  });

  it("matches a Summary heading case-insensitively", () => {
    expect(webuiPlanSummary("# T\n\n## summary\n\nbody\n\n## Next\n\nnope")).toBe("body");
  });

  it("keeps a fenced block inside the summary instead of cutting at its hashes", () => {
    const markdown = ["# T", "", "## Summary", "", "before", "", "```py", "# comment", "x = 1", "```", "", "after"].join("\n");
    const summary = webuiPlanSummary(markdown);
    expect(summary).toContain("# comment");
    expect(summary).toContain("after");
  });

  it("falls back to the first prose line when there is no Summary", () => {
    expect(webuiPlanSummary("# Title\n\n第一段正文\n\n第二段")).toBe("第一段正文");
    // A heading-only plan must not preview a heading as if it were prose.
    expect(webuiPlanSummary("# Title\n\n## Sub")).toBe("");
  });

  it("builds the three decision payloads against the plan-review step", () => {
    expect(buildWebuiPlanApproveAnswers()).toEqual([
      { stepId: "plan-review", selectedOptionIds: ["approve"], selectedOther: false },
    ]);
    expect(buildWebuiPlanFeedbackAnswers("  换个画风  ")).toEqual([
      { stepId: "plan-review", selectedOptionIds: [], selectedOther: true, otherText: "换个画风" },
    ]);
    expect(buildWebuiPlanSkipAnswers()).toEqual([
      { stepId: "plan-review", selectedOptionIds: [], selectedOther: false, skipped: true },
    ]);
  });

  it("reads a skipped answer as the turn ending, not resuming", () => {
    // The runtime returns `{ ok: true }` for skip, approve and feedback
    // alike, so `skipped` is the only signal the reply carries.
    expect(webuiAnswersEndTurn(buildWebuiPlanSkipAnswers())).toBe(true);
    expect(webuiAnswersEndTurn(buildWebuiPlanApproveAnswers())).toBe(false);
    expect(webuiAnswersEndTurn(buildWebuiPlanFeedbackAnswers("换个画风"))).toBe(false);
    expect(webuiAnswersEndTurn([])).toBe(false);
    expect(
      webuiAnswersEndTurn([
        { stepId: "plan-review", selectedOptionIds: [], selectedOther: false },
        { stepId: "plan-review", selectedOptionIds: [], selectedOther: false, skipped: true },
      ]),
    ).toBe(true);
  });

  it("builds the entry-confirmation payload against the plan-enter step", () => {
    expect(buildWebuiPlanEnterAnswers("confirm")).toEqual([
      { stepId: "plan-enter", selectedOptionIds: ["confirm"], selectedOther: false },
    ]);
  });

  it("hides an entry button the runtime did not offer", () => {
    const request = {
      ...planReviewRequest(),
      modePayload: undefined,
      steps: [step("plan-enter", { options: [{ id: "confirm", label: "继续" }] })],
    } as WebuiQuestionnaireRequest;
    expect(webuiPlanEnterOptions(request)).toEqual({ confirm: true, decline: false });
  });
});

describe("plan cards — SSR", () => {
  const noop = () => undefined;

  it("renders the delivery card with title, both actions and the summary", () => {
    const html = renderToStaticMarkup(
      createElement(WebuiPlanDeliveryCard, { request: planReviewRequest(), onBuild: noop }),
    );
    expect(html).toContain('data-testid="plan-delivery-card"');
    expect(html).toContain('data-request-id="ask_plan_1"');
    expect(html).toContain('data-testid="plan-delivery-title"');
    expect(html).toContain("鹦鹉骑自行车 SVG");
    // 执行 / 预览 — the two actions the WebUI was missing.
    expect(html).toContain('data-testid="plan-build"');
    expect(html).toContain('data-testid="plan-build-label"');
    expect(html).toContain(">执行<");
    expect(html).toContain('data-testid="plan-view"');
    expect(html).toContain('data-testid="plan-view-label"');
    expect(html).toContain(">预览<");
    // The summary previews the Summary section, not the whole file.
    expect(html).toContain('data-testid="plan-delivery-summary"');
    expect(html).toContain("交付一个自包含的静态 SVG 文件");
    expect(html).not.toContain("画布与调色板");
    // The warning description rides under the title.
    expect(html).toContain('data-testid="plan-review-description"');
    expect(html).toContain("已写好计划，确认后实施");
  });

  it("falls back to 计划 when the markdown has no level-1 heading", () => {
    const request = planReviewRequest({
      modePayload: { planReview: { markdown: "只有正文", path: "/tmp/plan.md" } },
    });
    const html = renderToStaticMarkup(
      createElement(WebuiPlanDeliveryCard, { request, onBuild: noop }),
    );
    expect(html).toContain("计划");
  });

  it("omits the summary block when there is nothing to preview", () => {
    const request = planReviewRequest({
      modePayload: { planReview: { markdown: "", path: "/tmp/plan.md" } },
    });
    const html = renderToStaticMarkup(
      createElement(WebuiPlanDeliveryCard, { request, onBuild: noop }),
    );
    expect(html).toContain('data-testid="plan-delivery-card"');
    expect(html).not.toContain('data-testid="plan-delivery-summary"');
  });

  it("disables the build action and surfaces the error while busy", () => {
    const html = renderToStaticMarkup(
      createElement(WebuiPlanDeliveryCard, {
        request: planReviewRequest(),
        onBuild: noop,
        onViewPlan: noop,
        chrome: { busy: true, error: "提交失败" },
      }),
    );
    expect(html).toMatch(/data-testid="plan-build"[^>]*disabled/);
    // 预览 opens the workspace panel, not a pending submission, so it stays
    // usable while the decision is in flight.
    expect(html).not.toMatch(/data-testid="plan-view"[^>]*disabled/);
    expect(html).toContain("提交失败");
  });

  it("disables 预览 when there is no panel to open", () => {
    const html = renderToStaticMarkup(
      createElement(WebuiPlanDeliveryCard, { request: planReviewRequest(), onBuild: noop }),
    );
    expect(html).toMatch(/data-testid="plan-view"[^>]*disabled/);
  });

  it("renders the summary in full — no height cap to scroll past", () => {
    const html = renderToStaticMarkup(
      createElement(WebuiPlanDeliveryCard, {
        request: planReviewRequest(),
        onBuild: noop,
        onViewPlan: noop,
      }),
    );
    // The whole Summary section, not just its opening lines.
    expect(html).toContain("交付一个自包含的静态 SVG 文件");
    expect(html).not.toContain("data-plan-preview-open");
  });

  it("renders the decision card with approve, feedback row and skip", () => {
    const html = renderToStaticMarkup(
      createElement(WebuiPlanReviewDecision, { request: planReviewRequest(), onAnswers: noop }),
    );
    expect(html).toContain('data-testid="plan-review-decision"');
    expect(html).toContain("计划完成，实施计划？");
    expect(html).toContain('data-testid="plan-review-approve"');
    expect(html).toContain("是，实施计划");
    expect(html).toContain('data-testid="plan-review-feedback-input"');
    expect(html).toContain("否，告诉MiniMax Code 如何调整...");
    expect(html).toContain('data-testid="plan-review-skip"');
    expect(html).toContain(">跳过<");
    expect(html).toContain('data-testid="plan-review-close"');
    // Empty input: the row is unselected and 发送 is absent.
    expect(html).toContain('data-selected="false"');
    expect(html).not.toContain('data-testid="plan-review-feedback-submit"');
  });

  it("renders the entry confirmation with both buttons and the desktop copy", () => {
    const request = {
      ...planReviewRequest(),
      modePayload: undefined,
      steps: [step("plan-enter")],
    } as WebuiQuestionnaireRequest;
    const html = renderToStaticMarkup(
      createElement(WebuiPlanEnterConfirmation, { request, onAnswers: noop }),
    );
    expect(html).toContain('data-testid="plan-enter-confirmation"');
    expect(html).toContain("使用计划模式？");
    expect(html).toContain("计划模式会在执行前先梳理复杂任务。");
    expect(html).toContain('data-testid="plan-enter-confirm"');
    expect(html).toContain("继续制定计划");
    expect(html).toContain('data-testid="plan-enter-decline"');
    expect(html).toContain("拒绝");
  });

  it("dispatches the decision card for a written plan and the confirmation for a bare one", () => {
    const review = renderToStaticMarkup(
      createElement(WebuiPlanSurface, { request: planReviewRequest(), onAnswers: noop }),
    );
    expect(review).toContain('data-testid="plan-review-decision"');
    expect(review).not.toContain('data-testid="plan-enter-confirmation"');

    const entering = renderToStaticMarkup(
      createElement(WebuiPlanSurface, {
        request: { ...planReviewRequest(), modePayload: undefined, steps: [step("plan-enter")] },
        onAnswers: noop,
      }),
    );
    expect(entering).toContain('data-testid="plan-enter-confirmation"');

    // Anything that is not a plan request is not this surface's business.
    const other = renderToStaticMarkup(
      createElement(WebuiPlanSurface, {
        request: { ...planReviewRequest(), mode: "questionnaire" },
        onAnswers: noop,
      }),
    );
    expect(other).toBe("");
  });
});

describe("interaction panel — plan routing", () => {
  const panelProps = {
    sessionId: "s1",
    permissions: [],
    onPermission: () => Promise.resolve(),
    onQuestionnaire: () => Promise.resolve(),
    onDismiss: () => Promise.resolve(),
  };

  it("routes a plan request to the decision card, not the generic questionnaire", () => {
    const html = renderToStaticMarkup(
      createElement(WebuiInteractionPanel, { ...panelProps, questionnaire: planReviewRequest() }),
    );
    expect(html).toContain('data-testid="plan-surface"');
    expect(html).toContain('data-testid="plan-review-decision"');
    // The plan FILE is a message in the transcript, not part of this panel —
    // the desktop anchors it to the turn that wrote the plan.
    expect(html).not.toContain('data-testid="plan-delivery-card"');
    // The generic step picker must not render for a plan request.
    expect(html).not.toContain('data-testid="questionnaire-composer"');
    expect(html).not.toContain('data-testid="questionnaire-step-plan-review"');
  });

  it("claims the composer slot when the request sets replaceComposer", () => {
    const html = renderToStaticMarkup(
      createElement(WebuiInteractionPanel, { ...panelProps, questionnaire: planReviewRequest() }),
    );
    expect(html).toContain('data-webui-composer-replaced="true"');
  });

  it("stacks above the composer when the request keeps the composer", () => {
    const request = {
      ...planReviewRequest(),
      presentation: {
        replaceComposer: false,
        showProgress: false,
        allowBackNavigation: false,
      },
    } as WebuiQuestionnaireRequest;
    const html = renderToStaticMarkup(
      createElement(WebuiInteractionPanel, { ...panelProps, questionnaire: request }),
    );
    expect(html).toContain('data-webui-composer-replaced="false"');
  });

  it("does not claim the composer slot when only a permission is pending", () => {
    const html = renderToStaticMarkup(
      createElement(WebuiInteractionPanel, {
        ...panelProps,
        permissions: [
          {
            requestId: "perm-1",
            sessionId: "s1",
            agentName: "main",
            toolName: "bash",
            ruleContents: [],
            reason: "why",
            allowAlwaysSupported: false,
            createdAt: 0,
          },
        ],
      }),
    );
    expect(html).toContain('data-webui-composer-replaced="false"');
    expect(html).not.toContain('data-testid="plan-surface"');
  });

  it("still renders the generic questionnaire for a non-plan request", () => {
    const request = {
      ...planReviewRequest(),
      mode: "questionnaire",
      modePayload: undefined,
      steps: [step("q1", { question: "选哪个？", options: [{ id: "o1", label: "甲" }] })],
    } as WebuiQuestionnaireRequest;
    const html = renderToStaticMarkup(
      createElement(WebuiInteractionPanel, { ...panelProps, questionnaire: request }),
    );
    expect(html).toContain('data-testid="questionnaire-composer"');
    expect(html).toContain('data-testid="questionnaire-step-q1"');
    expect(html).not.toContain('data-testid="plan-surface"');
  });
});
