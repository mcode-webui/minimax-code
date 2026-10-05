// The multi-step questionnaire, end to end against the built client.
//
// The unit suite covers the pure helpers and the panel's static markup; what
// only a real browser proves is the interaction itself — the click-by-click
// contract the roadmap's ➖ stood for:
//
//   1. stepping forward and back with the progress row, and the required
//      gate: 下一步 and 提交 stay disabled until a required step is answered;
//   2. multi-select toggling and the 可多选 hint;
//   3. the custom answer row;
//   4. 提交 shipping the accumulated answers over the wire;
//   5. 关闭 and 跳过 both routing through dismissQuestionnaire;
//   6. the goal auto-reply countdown: shown only for goal questionnaires,
//      titled with what the runtime actually does (采用推荐选项, not 提交),
//      marking the recommended option, and saying the window is over at zero
//      instead of parking at a bare ⏱ 0s;
//   7. a multi-step request with no presentation block renders instead of
//      throwing the whole surface away.
//
// Countdown boundary, stated once here because it shapes test 6: the runtime
// owns the auto-reply (QuestionnaireAutoReplyScheduler fires for
// purpose === 'goal' and applies each step's recommended option; a manual
// answer beats it through its CAS). The fixture transport has no runtime, so
// "the scheduler really submits" is not assertable in this suite — what is
// assertable is that the client renders the window honestly and never
// promises one for a questionnaire the runtime would not answer.

import { expect } from "@playwright/test";

import { openApp, test } from "./harness.mjs";

test.beforeEach(async ({ page }) => {
  page.on("pageerror", (error) => console.error("BROWSER_PAGE_ERROR", error.stack ?? error.message));
  page.on("console", (message) => { if (message.type() === "error") console.error("BROWSER_CONSOLE_ERROR", message.text()); });
});

function step(id, question, over = {}) {
  return { id, question, selectionMode: 0, allowOther: false, otherPlaceholder: "", required: false, ...over };
}

function request(steps, over = {}) {
  return {
    schemaVersion: 2,
    id: "q-spec",
    title: "浏览器实测问卷",
    presentation: { replaceComposer: true, showProgress: true, allowBackNavigation: true },
    steps,
    ...over,
  };
}

/**
 * Stages the questionnaire before the app boots; the composer's first poll
 * picks it up. Registered on the harness's `__WEBUI_FIXTURE_SETUP__` queue
 * (which runs after the fixture transport installs) through `addInitScript`
 * with the payload as an argument — `configureFixture` serialises the setup
 * with `toString()`, so a closed-over request would arrive as a ReferenceError.
 */
async function stageQuestionnaire(page, questionnaire) {
  await page.addInitScript((value) => {
    window.__WEBUI_FIXTURE_SETUP__ ??= [];
    window.__WEBUI_FIXTURE_SETUP__.push(() => window.__fixture.setQuestionnaire(value));
  }, questionnaire);
}

const card = (page) => page.locator('[data-testid="questionnaire-composer"]');

test("steps forward and back, gating every required step", async ({ page }) => {
  await stageQuestionnaire(page, request([
    step("s1", "第一问（必填单选）", { required: true, options: [{ id: "o1a", label: "选项A", recommended: true }, { id: "o1b", label: "选项B" }] }),
    step("s2", "第二问（多选）", { selectionMode: 1, options: [{ id: "o2a", label: "甲" }, { id: "o2b", label: "乙" }, { id: "o2c", label: "丙" }] }),
    step("s3", "第三问（自定义）", { allowOther: true, otherPlaceholder: "说说你的想法" }),
  ]));
  await openApp(page, "#session=A");

  await expect(card(page)).toBeVisible();
  await expect(page.locator('[data-testid="questionnaire-progress"]')).toHaveText("‹1/3›");

  // Required, unanswered: both ways forward are locked. This is the gate the
  // roadmap's 必填校验 row claimed — asserted on the real buttons.
  const next = page.locator('[data-testid="questionnaire-next"]');
  const submit = page.locator('button:has-text("提交")');
  await expect(next).toBeDisabled();
  await expect(submit).toBeDisabled();

  await page.locator('[data-webui-questionnaire-option="o1a"]').click();
  await expect(next).toBeEnabled();
  await next.click();
  await expect(page.locator('[data-testid="questionnaire-progress"]')).toHaveText("‹2/3›");

  // Multi-select: the hint is the only signal the row offers that Space-like
  // toggling, not replacement, is the semantics.
  await expect(page.locator('[data-testid="questionnaire-multi-hint-s2"]')).toBeVisible();
  await page.locator('[data-webui-questionnaire-option="o2a"]').click();
  await page.locator('[data-webui-questionnaire-option="o2c"]').click();
  await expect(page.locator('[data-webui-questionnaire-option="o2a"]')).toHaveAttribute("data-selected", "true");
  await expect(page.locator('[data-webui-questionnaire-option="o2c"]')).toHaveAttribute("data-selected", "true");

  // Back: the first step's answer survives the round trip.
  await page.locator('[data-testid="questionnaire-progress-prev"]').click();
  await expect(page.locator('[data-testid="questionnaire-progress"]')).toHaveText("‹1/3›");
  await expect(page.locator('[data-webui-questionnaire-option="o1a"]')).toHaveAttribute("data-selected", "true");
  await page.locator('[data-testid="questionnaire-next"]').click();

  // Custom answer on the final step, then the gate opens for submit.
  await page.locator('[data-testid="questionnaire-next"]').click();
  const other = page.locator('[data-webui-questionnaire-other="s3"] input[type="text"]');
  await other.click();
  await other.fill("我的自定义答案");
  await expect(page.locator('[data-webui-questionnaire-other="s3"]')).toHaveAttribute("data-selected", "true");
  await expect(submit).toBeEnabled();
});

test("提交 ships the accumulated answers over the wire", async ({ page }) => {
  await stageQuestionnaire(page, request([
    step("s1", "必填单选", { required: true, options: [{ id: "a", label: "A" }] }),
    step("s2", "多选", { selectionMode: 1, options: [{ id: "b", label: "B" }, { id: "c", label: "C" }] }),
  ]));
  await openApp(page, "#session=A");

  await page.locator('[data-webui-questionnaire-option="a"]').click();
  await page.locator('[data-testid="questionnaire-next"]').click();
  await page.locator('[data-webui-questionnaire-option="b"]').click();
  await page.locator('button:has-text("提交")').click();

  // The payload is the point: one answer per step, in step order, with the
  // multi-select carrying both ids and the untouched step carrying none.
  await expect.poll(() =>
    page.evaluate(() => window.__fixture.requests.filter((r) => r.operation === "replyQuestionnaire").at(-1)?.body),
  ).toEqual({
    name: "synthetic-A",
    requestId: "q-spec",
    schemaVersion: 2,
    answers: [
      { stepId: "s1", selectedOptionIds: ["a"] },
      { stepId: "s2", selectedOptionIds: ["b"] },
    ],
  });
});

test("关闭 and 跳过 both route through dismissQuestionnaire", async ({ page }) => {
  await stageQuestionnaire(page, request([
    step("s1", "先测关闭", { options: [{ id: "x", label: "选项" }] }),
  ]));
  await openApp(page, "#session=A");
  await expect(card(page)).toBeVisible();

  await page.locator('[data-testid="questionnaire-close"]').click();
  await expect.poll(() =>
    page.evaluate(() => window.__fixture.requests.filter((r) => r.operation === "dismissQuestionnaire").length),
  ).toBe(1);

  // 跳过 on a fresh card — same wire destination, different affordance. The
  // two must not be conflated into one button, and neither may submit
  // answers. (Direct evaluate, not `stageQuestionnaire`: init scripts do not
  // re-run on a hash change.)
  await page.evaluate((value) => window.__fixture.setQuestionnaire(value), request([
    step("s1", "再测跳过", { required: true, options: [{ id: "y", label: "必填项" }] }),
  ]));
  await page.evaluate(() => { window.location.hash = "session=B"; });
  await expect(card(page)).toBeVisible();
  await page.locator('button:has-text("跳过")').click();
  await expect.poll(() =>
    page.evaluate(() => window.__fixture.requests.filter((r) => r.operation === "dismissQuestionnaire").length),
  ).toBe(2);
  expect(await page.evaluate(() => window.__fixture.requests.some((r) => r.operation === "replyQuestionnaire"))).toBe(false);
});

test("the goal countdown renders its window honestly, and only for goal requests", async ({ page }) => {
  // The ordinary half first: same expiry, no purpose — no countdown, because
  // the runtime's scheduler would never answer it.
  await stageQuestionnaire(page, request([
    step("s1", "普通问卷", { options: [{ id: "n", label: "普通选项" }] }),
  ], { expiresAt: Date.now() + 4_000 }));
  await openApp(page, "#session=A");
  await expect(card(page)).toBeVisible();
  await expect(page.locator('[data-testid="questionnaire-auto-reply-countdown"]')).toHaveCount(0);
  await expect(page.locator('[data-testid="questionnaire-recommended-n"]')).toHaveCount(0);

  // Now the goal half, with a recommended option to apply. (Direct evaluate —
  // `stageQuestionnaire`'s init script does not re-run on a hash change.)
  await page.evaluate((value) => window.__fixture.setQuestionnaire(value), request([
    step("sg", "目标确认", { options: [{ id: "rec", label: "推荐继续", recommended: true }, { id: "alt", label: "换个方案" }] }),
  ], { purpose: 1, expiresAt: Date.now() + 4_000 }));
  await page.evaluate(() => { window.location.hash = "session=B"; });
  await expect(card(page)).toBeVisible();

  const countdown = page.locator('[data-testid="questionnaire-auto-reply-countdown"]');
  await expect(countdown).toBeVisible();
  // Says what the runtime does — 采用推荐选项, not a bare 自动提交 — and marks
  // the option it would apply (only that one).
  await expect(countdown).toContainText(/⏱ [1-4]s/u);
  expect(await countdown.getAttribute("title")).toContain("自动采用推荐选项");
  await expect(page.locator('[data-testid="questionnaire-recommended-rec"]')).toHaveText("（推荐）");
  await expect(page.locator('[data-testid="questionnaire-recommended-alt"]')).toHaveCount(0);

  // At zero: the window says it is over. The fixture has no runtime, so no
  // reply fires here — the real submission is the scheduler's, source-verified
  // in GoalQuestionnaireService.runAutoReply (see the spec header).
  await expect(countdown).toHaveText("⏱ 时间到 · 正在采用推荐选项…", { timeout: 8_000 });
});

test("a multi-step request with no presentation block renders instead of throwing", async ({ page }) => {
  const withPresentation = request([
    step("m1", "无展示配置第一问"),
    step("m2", "无展示配置第二问"),
  ]);
  const { presentation, ...without } = withPresentation;
  await stageQuestionnaire(page, without);
  await openApp(page, "#session=A");

  // The throw shape: `steps.length > 1` un-shortcircuits the progress guard,
  // which used to read `.showProgress` off the absent block and kill the
  // whole surface. The defaults come from the producers' own
  // DEFAULT_PRESENTATION: progress shown, back navigation allowed.
  await expect(page.locator('[data-testid="webui-error-boundary"]')).toHaveCount(0);
  await expect(card(page)).toBeVisible();
  await expect(page.locator('[data-testid="questionnaire-progress"]')).toHaveText("‹1/2›");
});
