import { useState, type ReactElement } from "react";
import type { WebuiQuestionnaireAnswer } from "../../../../shared/contracts/interactions.js";
import { WebuiButton } from "../../../ui/button.js";
import {
  WebuiCheckbox,
  WebuiField,
  WebuiFieldError,
  WebuiRadio,
  WebuiTextInput,
} from "../../../ui/field.js";
import {
  designQuestionAnswered,
  designQuestionChoice,
  designQuestionOther,
} from "../projection/design-view.js";
import {
  designQuestionSteps,
  designQuestionError,
  designSkippedAnswers,
} from "../projection/design-questionnaire.js";
import { useWebuiToastError } from "../../../ui/toast.js";

/** Answers the host's actual step identities and choice contract. */
export function DesignQuestionnaire({
  request,
  onAnswer,
  onOpenChat,
}: {
  readonly request: unknown;
  readonly onAnswer: (
    answers: readonly WebuiQuestionnaireAnswer[],
  ) => Promise<void>;
  readonly onOpenChat?: () => void;
}): ReactElement {
  const steps = designQuestionSteps(request);
  const [answers, setAnswers] = useState<
    Readonly<Record<string, WebuiQuestionnaireAnswer>>
  >({});
  const [error, setError] = useState<string>();
  const [operationError, setOperationError] = useState<string>();
  useWebuiToastError(operationError);
  const answer = (id: string): WebuiQuestionnaireAnswer =>
    answers[id] ?? { stepId: id, selectedOptionIds: [], selectedOther: false };
  if (!steps)
    return (
      <div className="webui-design-questionnaire">
        <p>Agent 提出了一个问题，请在对话中查看并回答。</p>
        {onOpenChat ? (
          <WebuiButton
            variant="quiet-action"
            size="inline-dense"
            onClick={onOpenChat}
          >
            在对话中回答
          </WebuiButton>
        ) : (
          <p>当前宿主未提供对话跳转，请回到生成所在的会话回答。</p>
        )}
      </div>
    );
  const submit = async (skip = false) => {
    const missing = skip ? undefined : designQuestionError(steps, answers);
    if (missing) {
      setError(missing);
      return;
    }
    setError(undefined);
    setOperationError(undefined);
    try {
      await onAnswer(
        skip
          ? designSkippedAnswers(steps)
          : steps.map((step) => answer(step.id)),
      );
    } catch (reason) {
      setOperationError(
        reason instanceof Error ? reason.message : String(reason),
      );
    }
  };
  return (
    <form
      className="webui-design-questionnaire"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      {steps.map((step) => {
        const id = String(step.id);
        const current = answer(id);
        const multiple = step.multiple;
        return (
          <fieldset className="webui-design-questionnaire-step" key={id}>
            <legend>
              {step.label}
              {step.required ? " *" : ""}
            </legend>
            {step.description ? <p>{step.description}</p> : null}
            {step.options.map((option) => {
              const optionId = String(option.id);
              const Control = multiple ? WebuiCheckbox : WebuiRadio;
              return (
                <label className="webui-design-choice" key={optionId}>
                  <Control
                    name={id}
                    checked={Boolean(
                      current.selectedOptionIds?.includes(optionId),
                    )}
                    onChange={() => {
                      setAnswers({
                        ...answers,
                        [id]: designQuestionChoice(current, optionId, multiple),
                      });
                    }}
                  />
                  <span>
                    {String(option.label ?? optionId)}
                    {option.description ? (
                      <small>{String(option.description)}</small>
                    ) : null}
                  </span>
                </label>
              );
            })}
            {step.allowOther ? (
              <div>
                {step.options.length ? (
                  <label className="webui-design-choice">
                    <WebuiCheckbox
                      checked={current.selectedOther === true}
                      onChange={(event) =>
                        setAnswers({
                          ...answers,
                          [id]: designQuestionOther(
                            current,
                            multiple,
                            event.currentTarget.checked,
                          ),
                        })
                      }
                    />
                    <span>其他答案</span>
                  </label>
                ) : null}
                <WebuiField
                  label={step.options.length ? "其他答案内容" : "你的回答"}
                  control={(field) => (
                    <WebuiTextInput
                      {...field}
                      value={current.otherText ?? ""}
                      placeholder={step.otherPlaceholder}
                      onChange={(event) =>
                        setAnswers({
                          ...answers,
                          [id]: designQuestionOther(
                            current,
                            multiple,
                            true,
                            event.target.value,
                          ),
                        })
                      }
                    />
                  )}
                />
              </div>
            ) : null}
            {error &&
            ((step.required && !designQuestionAnswered(current)) ||
              (current.selectedOther && !current.otherText?.trim())) ? (
              <WebuiFieldError message={error} />
            ) : null}
          </fieldset>
        );
      })}
      <div className="webui-design-task-panel-actions">
        <WebuiButton
          variant="accent"
          size="inline-dense"
          onClick={() => submit()}
        >
          提交
        </WebuiButton>
        <WebuiButton
          variant="quiet-action"
          size="inline-dense"
          onClick={() => submit(true)}
        >
          跳过
        </WebuiButton>
        {onOpenChat ? (
          <WebuiButton
            variant="quiet-action"
            size="inline-dense"
            onClick={onOpenChat}
          >
            在对话里打开
          </WebuiButton>
        ) : null}
      </div>
    </form>
  );
}
