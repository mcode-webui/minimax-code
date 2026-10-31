// OutputError — the error footer shown beneath the last assistant turn whenever
// the streaming pipeline reports a failure or retry state. Testids, class
// composition, and count-down math (10s rate-limit window, default `0` when
// `errorAt` is missing) are pinned by `output-error.test.tsx`.
//
// The icon hover overlay uses the `mavis-output-error-tooltip` class and the
// retry row uses the shared black button (`mavis-button.black`). Both are
// external dependencies the integrator must wire; this component leaves the
// same slots open via props (`renderIconTooltip`, `renderRetryButton`) so a
// unit test can pin the output structure without dragging antd in.
//
// `variant` accepts the `OutputRetrying` / `OutputRateLimited` / `OutputError`
// variants as plain string literals to keep this file dependency-free.

import { useEffect, useState, type ReactNode } from "react";
import { IconAlertCircle } from "@tabler/icons-react";
import { FeedbackLiveRegion } from "../../../ui/feedback.js";

export type OutputErrorVariant = "output_retrying" | "output_rate_limited" | "output_error";

export interface OutputErrorRetryCount {
  current: number;
  total: number;
}

export interface OutputErrorProps {
  variant: OutputErrorVariant;
  text: ReactNode;
  iconTooltip?: string;
  onRetry?: () => void;
  retryLabel?: ReactNode;
  errorAt?: number;
  retryCount?: OutputErrorRetryCount;
  testId?: string;
  title?: string;
  role?: string;
  ariaLive?: "polite" | "assertive" | "off";
}

function computeRemainingSeconds(errorAt: number | undefined): number {
  if (errorAt === undefined) return 0;
  return Math.max(0, 10 - Math.floor((Date.now() - errorAt) / 1000));
}

function formatRetryCount(count: OutputErrorRetryCount | undefined): string | null {
  if (!count) return null;
  const current = Math.max(0, Math.floor(count.current));
  const total = Math.max(0, Math.floor(count.total));
  if (total === 0) return null;
  return `（${Math.min(current, total)}/${total}）`;
}

function DefaultRetryButton({ className, onClick, children }: {
  className: string;
  onClick: () => void;
  children: ReactNode;
}): React.JSX.Element {
  return (
    <button
      type="button"
      className={className}
      data-testid="output-error-retry"
      onClick={(event) => {
        event.stopPropagation();
        onClick();
      }}
    >
      {children}
    </button>
  );
}

function DefaultIcon({ tooltip, renderIconTooltip }: {
  tooltip?: string;
  renderIconTooltip?: (icon: ReactNode, tooltip?: string) => ReactNode;
}): React.JSX.Element {
  const icon = <IconAlertCircle width={16} height={16} aria-hidden="true" focusable="false" stroke={1.7} />;
  if (renderIconTooltip) {
    return <>{renderIconTooltip(icon, tooltip)}</>;
  }
  return (
    <span
      className="mr-1 flex size-4 flex-shrink-0 items-center justify-center text-icon_default_secondary"
      data-testid="output-error-icon"
    >
      {icon}
    </span>
  );
}

export function OutputError(props: OutputErrorProps): React.JSX.Element {
  const {
    variant,
    text,
    iconTooltip,
    onRetry,
    retryLabel,
    errorAt,
    retryCount,
    testId = "output-error-alert",
    title,
    role,
    ariaLive,
    renderRetryButton,
    renderIconTooltip,
  } = props as OutputErrorProps & {
    renderRetryButton?: (params: { className: string; onClick: () => void; label: ReactNode }) => ReactNode;
    renderIconTooltip?: (icon: ReactNode, tooltip?: string) => ReactNode;
  };

  const isRetrying = variant === "output_retrying";
  const isRateLimited = variant === "output_rate_limited";

  const [remaining, setRemaining] = useState<number>(() => computeRemainingSeconds(errorAt));

  useEffect(() => {
    if (!isRateLimited) return undefined;
    const initial = computeRemainingSeconds(errorAt);
    setRemaining(initial);
    if (initial === 0) return undefined;
    const handle = setInterval(() => {
      const next = computeRemainingSeconds(errorAt);
      setRemaining(next);
      if (next === 0) clearInterval(handle);
    }, 1000);
    return () => clearInterval(handle);
  }, [errorAt, isRateLimited]);

  const showCountdown = isRateLimited && remaining > 0;
  const showRetryCount = !isRetrying ? formatRetryCount(retryCount) : null;
  const showRetry = !isRetrying && !showCountdown && onRetry;

  const retryButtonClass =
    "cursor-pointer !h-8 !px-3 !py-0 inline-flex items-center justify-center !text-sm !leading-5 !font-medium rounded-md border-[0.5px] border-border_default bg-bg_default_primary hover:bg-bg_interaction_tertiary_hover text-text_default_primary";

  const retryNode = showRetry ? (
    renderRetryButton ? (
      renderRetryButton({ className: retryButtonClass, onClick: () => onRetry!(), label: retryLabel ?? "重试" })
    ) : (
      <DefaultRetryButton className={retryButtonClass} onClick={() => onRetry!()}>
        {retryLabel ?? "重试"}
      </DefaultRetryButton>
    )
  ) : null;

  return (
    <div
      className="w-full pb-12"
      data-testid="output-error-surface"
      data-output-error-variant={variant}
    >
      <div
        className="flex h-10 w-full items-center"
        aria-hidden="true"
      >
        <div
          className="h-[0.5px] w-full bg-border_default"
          data-testid="output-error-divider"
        />
      </div>
      <FeedbackLiveRegion
        className="flex min-h-8 w-fit items-center text-body-base !tracking-[0px] text-text_default_secondary"
        testId={testId}
        politeness={ariaLive === "assertive" ? "assertive" : "polite"}
        dataAttributes={{
          ...(testId ? { "data-testid": testId } : {}),
          "data-output-error-variant": variant,
          ...(title ? { title } : {}),
          ...(role ? { role } : {}),
        }}
      >
        <DefaultIcon tooltip={iconTooltip} {...(renderIconTooltip ? { renderIconTooltip } : {})} />
        <span
          className="min-w-0 truncate text-body-base !tracking-[0px] !text-text_default_secondary"
          data-testid="output-error-text"
        >
          {text}
        </span>
        {showCountdown ? (
          <span
            className="ml-1 shrink-0 whitespace-nowrap"
            data-testid="output-error-countdown"
          >
            （{remaining}s）
          </span>
        ) : null}
        {showRetryCount ? (
          <span
            className="ml-1 shrink-0 whitespace-nowrap"
            data-testid="output-error-retry-count"
          >
            {showRetryCount}
          </span>
        ) : null}
        <span className="ml-4">{retryNode}</span>
      </FeedbackLiveRegion>
    </div>
  );
}
