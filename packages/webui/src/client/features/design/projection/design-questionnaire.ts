import type { WebuiQuestionnaireAnswer } from "../../../../shared/contracts/interactions.js";
import { record, records, designQuestionAnswered } from "./design-view.js";

export interface DesignQuestionStep {
  readonly id: string;
  readonly label: string;
  readonly description: string;
  readonly multiple: boolean;
  readonly allowOther: boolean;
  readonly required: boolean;
  readonly otherPlaceholder: string;
  readonly options: readonly {
    readonly id: string;
    readonly label: string;
    readonly description: string;
  }[];
}
/** Retain actual host identities; an unknown schema is answered in its conversation, never with fabricated ids. */
export function designQuestionSteps(
  request: unknown,
): readonly DesignQuestionStep[] | undefined {
  const source = Array.isArray(request)
    ? records(request)
    : records(record(request).steps);
  if (!source.length) return undefined;
  const steps: DesignQuestionStep[] = [];
  for (const step of source) {
    const id = step.id ?? step.stepId;
    if (typeof id !== "string" || !id) return undefined;
    const options = [];
    for (const option of records(step.options)) {
      const optionId = option.id ?? option.value;
      if (typeof optionId !== "string" || !optionId) return undefined;
      options.push({
        id: optionId,
        label: String(option.label ?? option.text ?? optionId),
        description: String(option.description ?? ""),
      });
    }
    steps.push({
      id,
      options,
      label: String(step.question ?? step.title ?? step.header ?? "请回答"),
      description: String(step.description ?? ""),
      multiple:
        step.selectionMode === 1 ||
        step.selectionMode === "multiple" ||
        step.multiSelect === true ||
        ["multi", "checkbox"].includes(String(step.type)),
      allowOther: step.allowOther !== false || !options.length,
      required: step.required !== false,
      otherPlaceholder: String(step.otherPlaceholder ?? ""),
    });
  }
  return steps;
}
export function designSkippedAnswers(
  steps: readonly DesignQuestionStep[],
): readonly WebuiQuestionnaireAnswer[] {
  return steps.map((step) => ({
    stepId: step.id,
    selectedOptionIds: [],
    selectedOther: false,
    skipped: true,
  }));
}
export function designQuestionError(
  steps: readonly DesignQuestionStep[],
  answers: Readonly<Record<string, WebuiQuestionnaireAnswer>>,
): string | undefined {
  const emptyOther = steps.find(
    (step) =>
      answers[step.id]?.selectedOther && !answers[step.id]?.otherText?.trim(),
  );
  if (emptyOther) return `请输入：${emptyOther.label} 的其他答案`;
  const missing = steps.find(
    (step) =>
      step.required &&
      !designQuestionAnswered(answers[step.id] ?? { stepId: step.id }),
  );
  return missing ? `请回答：${missing.label}` : undefined;
}
