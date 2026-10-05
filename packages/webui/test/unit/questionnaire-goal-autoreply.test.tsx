// Unit tests for the questionnaire panel's goal auto-reply window and its
// optional-presentation hardening.
//
// Two contracts, both verified broken-then-fixed in a real browser against
// the built client (see the I-1 PR for the click-by-click record):
//
//   1. The expiry countdown belongs to the GOAL flow alone. The runtime's
//      `QuestionnaireAutoReplyScheduler` (local-runtime) fires only for
//      `purpose === 'goal'`, applying each step's recommended option with a
//      CAS so a concurrent manual answer wins; the renderer is display-only
//      by that module's own contract. Before the fix the WebUI showed the
//      countdown for ANY request carrying `expiresAt` — a promise nothing
//      keeps for an ordinary questionnaire — and its title said 自动提交,
//      which is not what the runtime does (it applies the recommended
//      option), and marked nothing on the options the TUI labels
//      "(Recommended)".
//
//   2. `presentation` is declared required by the wire type, but the
//      runtime's view builder materialises it with `{...request.
//      presentation}` — `{}` for a payload that never had one — and every
//      producer-side normaliser defaults the three fields to true. A
//      multi-step request whose presentation block is absent entirely used
//      to throw `Cannot read properties of undefined (reading
//      'showProgress')` and kill the whole interaction surface (the error
//      boundary catches it now; before Q-1 it was a white page).
//
// `renderToStaticMarkup` runs the `useState` initialiser, so the countdown's
// first paint is assertable without a DOM; the interval itself only matters
// over time, which is the browser spec's half of the coverage.

import { describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { WebuiInteractionPanel } from "../../src/client/components/InteractionPanel.js";
import type { WebuiQuestionnaireRequest } from "../../src/server/port.js";

function request(over: Partial<WebuiQuestionnaireRequest> = {}): WebuiQuestionnaireRequest {
  return {
    schemaVersion: 2,
    id: "q-goal",
    title: "目标确认",
    presentation: { replaceComposer: true, showProgress: true, allowBackNavigation: true },
    steps: [
      {
        id: "s1",
        question: "继续吗？",
        selectionMode: 0,
        allowOther: false,
        otherPlaceholder: "",
        required: true,
        options: [
          { id: "rec", label: "推荐继续", recommended: true },
          { id: "alt", label: "换个方案" },
        ],
      },
    ],
    ...over,
  } as WebuiQuestionnaireRequest;
}

function render(questionnaire: WebuiQuestionnaireRequest): string {
  return renderToStaticMarkup(
    createElement(WebuiInteractionPanel, {
      sessionId: "s1",
      permissions: [],
      questionnaire,
      onPermission: vi.fn(async () => undefined),
      onQuestionnaire: vi.fn(async () => undefined),
      onDismiss: vi.fn(async () => undefined),
    }),
  );
}

describe("the goal auto-reply window", () => {
  it("shows the countdown only for a goal questionnaire", () => {
    const future = Date.now() + 30_000;
    const goal = render(request({ purpose: 1, expiresAt: future }));
    expect(goal).toContain('data-testid="questionnaire-auto-reply-countdown"');

    // The other half: an ordinary questionnaire carrying the same expiry
    // renders NO countdown — the runtime's auto-reply scheduler is goal-only,
    // so a visible countdown here would promise a reply nothing keeps.
    const ordinary = render(request({ expiresAt: future }));
    expect(ordinary).not.toContain("questionnaire-auto-reply-countdown");
  });

  it("titles the countdown with what the runtime actually does", () => {
    const html = render(request({ purpose: 1, expiresAt: Date.now() + 10_000 }));
    // 自动采用推荐选项, not 自动提交: the runtime applies each step's
    // recommended option (`GoalQuestionnaireService.runAutoReply`), it does
    // not submit the reader's half-filled form.
    expect(html).toContain("自动采用推荐选项");
    expect(html).not.toContain("自动提交");
  });

  it("marks the recommended option only while the window is open", () => {
    const goal = render(request({ purpose: 1, expiresAt: Date.now() + 10_000 }));
    expect(goal).toContain('data-testid="questionnaire-recommended-rec"');
    expect(goal).toContain("（推荐）");
    // A different option on the same step carries no mark, and the same
    // option carries none once no window is open — the mark answers "what
    // happens if I do nothing", which only a live window makes true.
    expect(goal).not.toContain('data-testid="questionnaire-recommended-alt"');
    const unmarked = render(request({ expiresAt: Date.now() + 10_000 }));
    expect(unmarked).not.toContain("questionnaire-recommended-");
  });

  it("says the window is over rather than parking at a bare zero", () => {
    const html = render(request({ purpose: 1, expiresAt: Date.now() - 1 }));
    // The scheduler owns the actual reply, so zero is a "hold on" state —
    // the same beat the TUI renders ("Time is up · applying the recommended
    // option…"), not an error and not a stuck ⏱ 0s with no explanation.
    expect(html).toContain("时间到 · 正在采用推荐选项…");
    expect(html).not.toMatch(/⏱\s*0s/u);
  });
});

describe("a presentation block that never arrived", () => {
  const twoSteps: WebuiQuestionnaireRequest = {
    ...request(),
    steps: [
      { id: "m1", question: "一", selectionMode: 0, allowOther: false, otherPlaceholder: "", required: false },
      { id: "m2", question: "二", selectionMode: 0, allowOther: false, otherPlaceholder: "", required: false },
    ],
  };

  it("renders a multi-step request with no presentation block at all", () => {
    // `presentation` entirely absent is the throw case: the progress row's
    // guard reads `presentation.showProgress` after `steps.length > 1`
    // short-circuits for single-step requests, so only the multi-step shape
    // reaches the read. This render used to throw.
    const { presentation, ...without } = twoSteps;
    expect(presentation).toBeDefined();
    const html = render(without as WebuiQuestionnaireRequest);
    expect(html).toContain('data-testid="questionnaire-composer"');
  });

  it("defaults the progress row and back navigation to the producers' default", () => {
    // `{...request.presentation}` in the runtime yields `{}` when the block
    // was absent — and DEFAULT_PRESENTATION (local-runtime) plus the TUI's
    // event-normalizer both default these fields to true, so the reader-side
    // `?? true` matches every producer's notion of "unspecified".
    const { presentation, ...without } = twoSteps;
    const html = render(without as WebuiQuestionnaireRequest);
    expect(html).toContain('data-testid="questionnaire-progress"');
    // The prev button is disabled on the FIRST step either way; the contract
    // under test is that the reader did not throw and the progress row is
    // shown, which the assertion above pins.
    expect(html).toContain("1/2");
  });

  it("honours an explicit showProgress: false when the block does arrive", () => {
    const html = render({
      ...twoSteps,
      presentation: { replaceComposer: true, showProgress: false, allowBackNavigation: true },
    });
    expect(html).not.toContain('data-testid="questionnaire-progress"');
  });
});
