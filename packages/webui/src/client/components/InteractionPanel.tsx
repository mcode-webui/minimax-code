// WebuiInteractionPanel — the per-session permission and questionnaire UI.
//
// W3 tier 3 lift: this component was moved verbatim out of `app.tsx`. The
// body is byte-identical to what used to live there; the lift is move-only.
// `app.tsx` keeps a thin re-export block so existing consumers
// (`webui-shell.test.ts`, `webui-round3-acceptance.test.tsx`, importers
// via `app.tsx`) keep their current import path during the W3 wave.

import { useEffect, useState, type ReactElement } from "react";
import {
  buildWebuiQuestionnaireAnswers,
  canAdvanceWebuiQuestionnaireStep,
  optionIdsForStep,
  sortWebuiQuestionnaireOptions,
  toggleWebuiQuestionnaireOption,
} from "../projection/questionnaire-state.js";
import { WebuiPlanSurface } from "./PlanModeCards.js";
import type {
  WebuiPendingPermission,
  WebuiQuestionnaireAnswer,
  WebuiQuestionnaireRequest,
} from "../../server/port.js";

export function WebuiInteractionPanel({
  sessionId,
  permissions,
  questionnaire,
  onPermission,
  onQuestionnaire,
  onDismiss,
  interactionError,
}: {
  readonly sessionId: string;
  readonly permissions: readonly WebuiPendingPermission[];
  readonly questionnaire?: WebuiQuestionnaireRequest;
  readonly onPermission: (
    request: WebuiPendingPermission,
    decision: "allowOnce" | "allowAlways" | "deny",
  ) => Promise<void>;
  readonly onQuestionnaire: (
    request: WebuiQuestionnaireRequest,
    answers: readonly WebuiQuestionnaireAnswer[],
  ) => Promise<void>;
  readonly onDismiss: (request: WebuiQuestionnaireRequest) => Promise<void>;
  readonly interactionError?: string;
}): ReactElement {
  const [selections, setSelections] = useState<
    Readonly<Record<string, readonly string[]>>
  >({});
  const [otherSelections, setOtherSelections] = useState<
    Readonly<Record<string, boolean>>
  >({});
  const [otherTexts, setOtherTexts] = useState<Readonly<Record<string, string>>>(
    {},
  );
  const [submitting, setSubmitting] = useState(false);
  const [currentStep, setCurrentStep] = useState(0);
  // The expiry countdown is the GOAL flow's auto-reply window, not a property
  // of questionnaires in general: the runtime's
  // `QuestionnaireAutoReplyScheduler` fires only for `purpose === 'goal'`
  // (`QuestionnairePurpose.Goal === 1` on this wire), applying each step's
  // recommended option. An ordinary questionnaire that happens to carry
  // `expiresAt` gets no runtime reply, so showing it a countdown would be a
  // promise nothing keeps — the TUI gates the same way
  // (`goalAutoReplyDeadline` in `questionnaire-picker.ts`). The `typeof` and
  // `isFinite` pair is that function's guard: without it a null or NaN
  // `expiresAt` lands on `Math.max(0, ...)` and the countdown renders
  // "time is up" for a value that never was a deadline.
  const goalAutoReplyWindow =
    questionnaire?.purpose === 1 &&
    typeof questionnaire.expiresAt === "number" &&
    Number.isFinite(questionnaire.expiresAt);
  const [remainingSeconds, setRemainingSeconds] = useState<number | undefined>(() =>
    goalAutoReplyWindow
      ? Math.max(0, Math.ceil((questionnaire!.expiresAt! - Date.now()) / 1000))
      : undefined,
  );
  useEffect(() => {
    setSelections({});
    setOtherSelections({});
    setOtherTexts({});
    setCurrentStep(0);
  }, [questionnaire?.id]);
  useEffect(() => {
    if (!goalAutoReplyWindow) {
      setRemainingSeconds(undefined);
      return undefined;
    }
    const update = () => setRemainingSeconds(Math.max(0, Math.ceil((questionnaire!.expiresAt! - Date.now()) / 1000)));
    update();
    const timer = window.setInterval(update, 1_000);
    return () => window.clearInterval(timer);
    // `id` rides along so replacing one goal questionnaire with another at the
    // same deadline re-derives the window instead of leaving the old interval
    // comparing against a deadline that no longer exists.
  }, [questionnaire?.id, questionnaire?.purpose, questionnaire?.expiresAt]);
  const visiblePermissions = permissions.filter(
    (permission) => permission.sessionId === sessionId,
  );
  const activeStep = questionnaire?.steps[currentStep];
  const activeSelected = activeStep ? optionIdsForStep(selections, activeStep.id) : [];
  const activeOther = activeStep ? otherSelections[activeStep.id] === true : false;
  const activeStepValid = canAdvanceWebuiQuestionnaireStep(
    activeStep,
    activeSelected,
    activeOther,
    otherTexts[activeStep?.id ?? ""] ?? "",
  );
  return (
    <div
      className="mt-3 flex w-full flex-col gap-3"
      data-webui-interactions={sessionId}
      data-webui-composer-replaced={
        // `presentation` is optional on the wire: the runtime's own event
        // normaliser defaults `replaceComposer` to true when it is absent, so
        // an absent block means "replace", not "unknown".
        questionnaire &&
        (questionnaire.presentation?.replaceComposer ?? true)
          ? "true"
          : "false"
      }
    >
      {visiblePermissions.map((permission) => (
        <article
          key={permission.requestId}
          className="webui-card flex flex-col gap-2 p-spacing_16"
          data-webui-permission-request={permission.requestId}
          aria-label="Permission request"
        >
          <strong>Permission required</strong>
          <span className="text-text_default_secondary text-size_14">
            {permission.toolName}: {permission.reason}
          </span>
          {permission.toolDescription ? (
            <span className="text-text_default_secondary text-size_12">
              {permission.toolDescription}
            </span>
          ) : null}
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              className="webui-button-primary text-size_14"
              onClick={() => void onPermission(permission, "allowOnce")}
            >
              Allow once
            </button>
            {permission.allowAlwaysSupported ? (
              <button
                type="button"
                className="webui-button-secondary text-size_14"
                onClick={() => void onPermission(permission, "allowAlways")}
              >
                Always allow
              </button>
            ) : null}
            <button
              type="button"
              className="webui-button-secondary text-size_14"
              onClick={() => void onPermission(permission, "deny")}
            >
              Deny
            </button>
          </div>
        </article>
      ))}
      {/* Plan mode arrives on the same questionnaire channel. Only the DECISION
          belongs here — the plan file card is a message in the transcript,
          anchored to the turn that wrote it, exactly as the desktop renders it.
          This surface takes the composer's place while the request is open
          (`presentation.replaceComposer`, the runtime's default for every
          questionnaire), which is what the attribute below switches the CSS to. */}
      {questionnaire?.mode === "plan" ? (
        <div
          className="webui-plan-surface"
          data-testid="plan-surface"
          data-webui-plan-request={questionnaire.id}
        >
          <WebuiPlanSurface
            request={questionnaire}
            chrome={{ busy: submitting, error: interactionError }}
            onAnswers={(answers) => {
              setSubmitting(true);
              void onQuestionnaire(questionnaire, answers).finally(() =>
                setSubmitting(false),
              );
            }}
          />
        </div>
      ) : null}
      {questionnaire && questionnaire.mode !== "plan" ? (
        <article
          className="webui-card flex max-h-[60vh] flex-col gap-3 overflow-hidden rounded-[20px] border-[0.5px] border-border_default bg-bg_grouped_secondary_elevated p-spacing_16"
          data-testid="questionnaire-composer"
          data-webui-questionnaire-request={questionnaire.id}
          aria-label={questionnaire.title ?? "Questionnaire"}
        >
          <div className="webui-questionnaire-content">
          <header className="webui-questionnaire-header">
            <strong
              className="text-size_16"
              data-webui-questionnaire-title="true"
            >
              {questionnaire.title ??
                questionnaire.steps[0]?.question ??
                "Questionnaire"}
            </strong>
            <button
              type="button"
              aria-label="关闭问卷"
              data-webui-dismiss-questionnaire="true"
              data-testid="questionnaire-close"
              className="webui-questionnaire-close"
              disabled={submitting}
              onClick={() => {
                setSubmitting(true);
                void onDismiss(questionnaire).finally(() =>
                  setSubmitting(false),
                );
              }}
            >
              ×
            </button>
          {/* `presentation` is optional at the reader: the wire type marks it
           * required, but the runtime's view builder materialises it with a
           * spread (`{...request.presentation}`), which yields `{}` — not a
           * defaulted block — for a payload that never had one. Every
           * producer-side normaliser defaults these three fields to true
           * (`DEFAULT_PRESENTATION` in local-runtime, the TUI's
           * event-normalizer), so `?? true` here is the same convention the
           * `replaceComposer` read two siblings up already follows. The bare
           * reads used to throw for a multi-step request with no presentation
           * block — the render died before the boundary existed. */}
          {questionnaire.steps.length > 1 && (questionnaire.presentation?.showProgress ?? true) ? (
              <span className="webui-questionnaire-progress" data-testid="questionnaire-progress" aria-label={`${currentStep + 1}/${questionnaire.steps.length}`}>
                <button type="button" data-testid="questionnaire-progress-prev" aria-label="上一步" onClick={() => setCurrentStep((value) => Math.max(0, value - 1))} disabled={submitting || !(questionnaire.presentation?.allowBackNavigation ?? true) || currentStep === 0}>‹</button>
                <span>{currentStep + 1}/{questionnaire.steps.length}</span>
                <button type="button" data-testid="questionnaire-progress-next" aria-label="下一步" onClick={() => setCurrentStep((value) => Math.min(questionnaire.steps.length - 1, value + 1))} disabled={submitting || currentStep >= questionnaire.steps.length - 1}>›</button>
              </span>
            ) : null}
          </header>
          <p
            className="webui-questionnaire-sub"
            data-webui-questionnaire-waiting="true"
          >
            智能体需要你的回答
          </p>
          {remainingSeconds !== undefined ? (
            <span
              className="webui-questionnaire-countdown"
              data-testid="questionnaire-auto-reply-countdown"
              title={remainingSeconds > 0 ? `将在 ${remainingSeconds} 秒后自动采用推荐选项` : "已到期，正在采用推荐选项"}
            >
              {remainingSeconds > 0
                ? `⏱ ${remainingSeconds}s`
                // The runtime's scheduler owns the actual reply (and a manual
                // answer beats it via its CAS arbitration), so zero is a
                // "hold on" state, not an error — the TUI shows the same
                // "Time is up · applying the recommended option…" beat.
                : "⏱ 时间到 · 正在采用推荐选项…"}
            </span>
          ) : null}
          <div data-testid="questionnaire-composer-body">
          {questionnaire.steps.slice(currentStep, currentStep + 1).map((step) => {
            const selected = optionIdsForStep(selections, step.id);
            const selectedOther = otherSelections[step.id] === true;
            const multiple =
              step.selectionMode === 1 ||
              (step.selectionMode as unknown) === "multiple";
            return (
              <fieldset key={step.id} className="mb-4" data-testid={`questionnaire-step-${step.id}`}>
                <legend
                  className="text-size_14 font-weight_medium"
                  data-webui-questionnaire-question="true"
                  data-testid={`questionnaire-step-title-${step.id}`}
                >
                  {step.question}
                </legend>
                {step.description ? (
                  <span className="text-text_default_secondary text-size_12">
                    {step.description}
                  </span>
                ) : null}
                <div
                  className="webui-questionnaire-options"
                  role={multiple ? "group" : "presentation"}
                >
                {multiple ? <span className="webui-questionnaire-multi-hint" data-testid={`questionnaire-multi-hint-${step.id}`}>可多选</span> : null}
                {sortWebuiQuestionnaireOptions(step.options ?? []).map((option, optionIndex) => {
                  const checked = selected.includes(option.id);
                  return (
                    <label
                      key={option.id}
                      className="webui-questionnaire-option"
                      data-selected={checked || undefined}
                      data-webui-questionnaire-option={option.id}
                    >
                      <input
                        type={multiple ? "checkbox" : "radio"}
                        name={`${questionnaire.id}-${step.id}`}
                        className="sr-only"
                        checked={checked}
                        onChange={() =>
                          {
                            setSelections((current) => ({
                              ...current,
                              [step.id]: toggleWebuiQuestionnaireOption(selected, option.id, multiple),
                            }));
                            if (!multiple)
                              setOtherSelections((current) => ({
                                ...current,
                                [step.id]: false,
                              }));
                          }
                        }
                      />
                      <span className="webui-questionnaire-letter" aria-hidden="true">
                        {String.fromCharCode(65 + optionIndex)}
                      </span>
                      <span>
                        {option.label}
                        {/* The TUI appends "(Recommended)" while the goal
                            auto-reply countdown runs, because that is the
                            option the runtime will apply if the reader does
                            nothing — the countdown alone does not say which
                            one it is. */}
                        {option.recommended && remainingSeconds !== undefined ? (
                          <small className="ml-1 text-text_default_secondary" data-testid={`questionnaire-recommended-${option.id}`}>
                            （推荐）
                          </small>
                        ) : null}
                        {option.description ? (
                          <small className="ml-1 text-text_default_secondary">
                            {option.description}
                          </small>
                        ) : null}
                      </span>
                    </label>
                  );
                })}
                </div>
                {step.allowOther ? (
                  <label
                    className="webui-questionnaire-other-row"
                    data-selected={selectedOther || undefined}
                    data-webui-questionnaire-other={step.id}
                  >
                    <input
                      type={multiple ? "checkbox" : "radio"}
                      name={`${questionnaire.id}-${step.id}`}
                      className="sr-only"
                      checked={selectedOther}
                      onChange={() => {
                        const next = !selectedOther;
                        setOtherSelections((current) => ({
                          ...current,
                          [step.id]: next,
                        }));
                        if (next && !multiple)
                          setSelections((current) => ({
                            ...current,
                            [step.id]: [],
                          }));
                      }}
                    />
                    <span
                      className="webui-questionnaire-other-toggle"
                      aria-hidden="true"
                    >
                      +
                    </span>
                    <span className="flex min-w-0 flex-1 flex-col">
                      <input
                        type="text"
                        value={otherTexts[step.id] ?? ""}
                        placeholder={
                          selectedOther
                            ? step.otherPlaceholder || "在这里输入..."
                            : "自定义回答..."
                        }
                        aria-label={`${step.question} 自定义回答`}
                        required={step.required && selectedOther}
                        readOnly={!selectedOther}
                        onFocus={() => {
                          if (selectedOther) return;
                          setOtherSelections((current) => ({
                            ...current,
                            [step.id]: true,
                          }));
                          setSelections((current) => ({
                            ...current,
                            [step.id]: [],
                          }));
                        }}
                        onChange={(event) =>
                          setOtherTexts((current) => ({
                            ...current,
                            [step.id]: event.target.value,
                          }))
                        }
                        className="webui-questionnaire-other-input"
                      />
                    </span>
                  </label>
                ) : null}
              </fieldset>
            );
          })}
          {activeStep && (activeStep.options?.length ?? 0) === 0 && !activeStep.allowOther ? (
            <p className="text-text_default_secondary text-size_12" data-testid="questionnaire-composer-empty">
              当前步骤没有可选项。
            </p>
          ) : null}
          </div>
          </div>
          <div className="webui-questionnaire-actions flex flex-wrap gap-2">
            {questionnaire.steps.length > 1 && currentStep > 0 ? <button type="button" className="webui-button-secondary text-size_14" disabled={submitting} data-testid="questionnaire-back" onClick={() => setCurrentStep((value) => Math.max(0, value - 1))}>上一步</button> : null}
            {questionnaire.steps.length > 1 && currentStep < questionnaire.steps.length - 1 ? <button type="button" className="webui-button-primary text-size_14" disabled={submitting || !activeStepValid} data-testid="questionnaire-next" onClick={() => setCurrentStep((value) => Math.min(questionnaire.steps.length - 1, value + 1))}>下一步</button> : null}
            <button
              type="button"
              className="webui-button-primary text-size_14"
              disabled={
                submitting ||
                currentStep < questionnaire.steps.length - 1 || !questionnaire.steps.every((step) => {
                  if (!step.required) return true;
                  if (otherSelections[step.id] === true)
                    return Boolean((otherTexts[step.id] ?? "").trim());
                  return optionIdsForStep(selections, step.id).length > 0;
                })
              }
              onClick={() => {
                setSubmitting(true);
                void onQuestionnaire(
                  questionnaire,
                  buildWebuiQuestionnaireAnswers(
                    questionnaire,
                    selections,
                    otherSelections,
                    otherTexts,
                  ),
                ).finally(() => setSubmitting(false));
              }}
            >
              提交
            </button>
            <button
              type="button"
              className="webui-button-secondary text-size_14"
              disabled={submitting}
              onClick={() => {
                setSubmitting(true);
                void onDismiss(questionnaire).finally(() =>
                  setSubmitting(false),
                );
              }}
            >
              跳过
            </button>
          </div>
        </article>
      ) : null}
          {interactionError ? (
        <p role="alert" data-testid="questionnaire-error" className="text-text_default_secondary text-size_12">
          Unable to answer interaction: {interactionError}
        </p>
      ) : null}
    </div>
  );
}
