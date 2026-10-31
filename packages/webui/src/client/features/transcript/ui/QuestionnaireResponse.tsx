// The transcript's historical questionnaire-response projection: a message in the
// conversation, so a rewound session still shows what the user picked.
//
// Cut out of `SessionTranscript.tsx` (view-model, scroll and response
// responsibilities). The transcript composes this surface; it does not own the
// interaction business the answers came from.

import type { ReactElement } from "react";

import type { WebuiQuestionnaireResponseSummary } from "../contracts/transcript-view.js";
import { formatWebuiMessageTimestamp } from "../projection/message-timestamp.js";
import { WebuiInline, WebuiStack } from "../../../ui/layout-primitives.js";

/**
 * Historical questionnaire-response projection. Once the user submits a
 * questionnaire we render the question and the recorded answers inside the
 * conversation so a rewinded session still remembers what the user picked.
 */
export function WebuiQuestionnaireResponse({
  messageId,
  summary,
  timestamp,
}: {
  readonly messageId: string;
  readonly summary: WebuiQuestionnaireResponseSummary;
  readonly timestamp?: number;
}): ReactElement {
  const { requestId, answers } = summary;
  return (
    <article
      className="webui-questionnaire-history flex w-full max-w-[80%] min-w-0 flex-col gap-3 rounded-2xl border-[0.5px] border-border_default bg-bg_grouped_secondary_elevated p-4 text-text_default_primary"
      data-webui-questionnaire-history="true"
      data-message-id={messageId}
      data-webui-questionnaire-request={requestId}
      data-testid={`questionnaire-history-${requestId}`}
    >
      <header className="flex min-w-0 items-center justify-between gap-3">
        <span
          className="text-size_14 font-medium leading-line_height_20 text-text_default_primary"
          data-testid="questionnaire-history-label"
        >
          问卷回答
        </span>
        {typeof timestamp === "number" ? (
          <time
            className="shrink-0 text-size_12 leading-line_height_16 text-text_default_tertiary"
            dateTime={new Date(timestamp).toISOString()}
            data-testid="questionnaire-history-timestamp"
          >
            {formatWebuiMessageTimestamp(timestamp)}
          </time>
        ) : null}
      </header>
      <WebuiStack
        as="ul"
        gap="medium"
        className="webui-questionnaire-history-answers min-w-0"
        data-testid="questionnaire-history-answers"
      >
        {answers.map((answer, index) => (
          <WebuiStack
            as="li"
            gap="compact"
            key={`${requestId}-${index}`}
            className="webui-questionnaire-history-answer min-w-0 text-size_14 leading-line_height_20"
            data-testid={`questionnaire-history-answer-${index}`}
          >
            <strong
              className="text-text_default_primary"
              data-testid={`questionnaire-history-answer-${index}-question`}
            >
              {answer.question}
            </strong>
            <WebuiInline as="ul" gap="small" wrap className="min-w-0">
              {answer.labels.map((label, labelIndex) => (
                <li
                  key={`${requestId}-${index}-${labelIndex}`}
                  className="webui-questionnaire-history-label max-w-full rounded-lg bg-bg_grouped_tertiary px-3 py-1.5 text-text_default_secondary [overflow-wrap:anywhere]"
                  data-testid={`questionnaire-history-answer-${index}-label-${labelIndex}`}
                >
                  <span>{label}</span>
                </li>
              ))}
            </WebuiInline>
          </WebuiStack>
        ))}
      </WebuiStack>
      <details className="webui-questionnaire-history-details border-t-[0.5px] border-border_default pt-2">
        <summary className="w-fit cursor-pointer text-size_12 leading-line_height_16 text-text_default_tertiary hover:text-text_default_secondary">
          查看回答信息
        </summary>
        <dl
          className="webui-questionnaire-history-meta mt-2 grid min-w-0 grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-size_12 leading-line_height_16 text-text_default_tertiary"
          data-testid="questionnaire-history-meta"
        >
          <div className="contents" data-testid="questionnaire-history-meta-requestId">
            <dt>requestId</dt>
            <dd className="min-w-0 break-all font-mono">{requestId || "(未提供)"}</dd>
          </div>
          {summary.schemaVersion ? (
            <div className="contents" data-testid="questionnaire-history-meta-schema">
              <dt>schemaVersion</dt>
              <dd className="font-mono">{summary.schemaVersion}</dd>
            </div>
          ) : null}
          {summary.submittedAt ? (
            <div className="contents" data-testid="questionnaire-history-meta-submitted">
              <dt>submittedAt</dt>
              <dd className="min-w-0 break-all font-mono">{summary.submittedAt}</dd>
            </div>
          ) : null}
          {summary.mode ? (
            <div className="contents" data-testid="questionnaire-history-meta-mode">
              <dt>mode</dt>
              <dd className="break-all font-mono">{summary.mode}</dd>
            </div>
          ) : null}
          {summary.source ? (
            <div className="contents" data-testid="questionnaire-history-meta-source">
              <dt>source</dt>
              <dd className="break-all font-mono">{summary.source}</dd>
            </div>
          ) : null}
          {summary.featureKey ? (
            <div className="contents" data-testid="questionnaire-history-meta-feature-key">
              <dt>featureKey</dt>
              <dd className="break-all font-mono">{summary.featureKey}</dd>
            </div>
          ) : null}
        </dl>
      </details>
    </article>
  );
}
