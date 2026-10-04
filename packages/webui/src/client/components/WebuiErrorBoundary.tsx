import { Component, type ErrorInfo, type ReactElement, type ReactNode } from "react";

/**
 * Normalises whatever a render threw. A component may throw a string or a
 * plain object, and the fallback must not itself throw while reporting the
 * failure — so the conversion happens once, here, instead of at each use site.
 * `String` is total for every value, which is what keeps the reporting path
 * free of a second failure.
 */
export function describeWebuiBoundaryError(error: unknown): Error {
  if (error instanceof Error) return error;
  return new Error(String(error));
}

/** Why the boundary holds the `Error` rather than a boolean: the fallback shows
 *  its message, and the same value is what reaches the console. A boolean would
 *  throw the diagnosis away and leave the console with a bare "render failed". */
export interface WebuiErrorBoundaryState {
  readonly error: Error | undefined;
}

export interface WebuiErrorBoundaryProps {
  readonly children: ReactNode;
  /** Overridable so a host can relabel the recoverable state without forking
   *  the markup. Defaults match the WebUI zh copy. */
  readonly title?: string;
  readonly detail?: string;
  readonly retryLabel?: string;
  /** Runs alongside the state reset, for a host that also wants to re-run a
   *  data fetch on retry. */
  readonly onReset?: () => void;
}

const COPY = {
  title: "界面出现错误",
  detail: "页面的一部分未能正常显示。应用已保留其余状态，可以重试恢复。",
  retry: "重试",
} as const;

/**
 * The recoverable state. Exported on its own so the failure surface can be
 * rendered and asserted without an instance of the boundary.
 */
export function WebuiErrorBoundaryFallback({
  error,
  title = COPY.title,
  detail = COPY.detail,
  retryLabel = COPY.retry,
  onRetry,
}: {
  readonly error: Error;
  readonly title?: string;
  readonly detail?: string;
  readonly retryLabel?: string;
  readonly onRetry: () => void;
}): ReactElement {
  return (
    <section
      role="alert"
      data-testid="webui-error-boundary"
      className="mx-auto flex min-h-screen max-w-xl flex-col items-center justify-center gap-spacing_8 p-spacing_24 text-center"
    >
      <h1 data-testid="webui-error-boundary-title" className="text-2xl font-semibold">{title}</h1>
      <p data-testid="webui-error-boundary-detail" className="text-text_default_secondary">{detail}</p>
      {/* The message is shown, not just logged: a user who cannot describe the
          failure to support has nothing to report, and this is the only place
          the cause survives the unmount of the tree that threw. */}
      <p
        data-testid="webui-error-boundary-message"
        className="max-w-full break-words font-mono text-text_default_tertiary"
      >
        {error.message}
      </p>
      <button
        type="button"
        data-testid="webui-error-boundary-retry"
        className="webui-button-secondary"
        onClick={onRetry}
      >
        {retryLabel}
      </button>
    </section>
  );
}

/**
 * The app's only render-error recovery path. Every client zone renders inside
 * it, so a throw in one panel degrades to a retryable surface instead of
 * unmounting the whole tree — which, with no boundary anywhere, was the only
 * prior behaviour.
 *
 * Deliberately a class component: `getDerivedStateFromError` and
 * `componentDidCatch` have no hook equivalent, so a function component cannot
 * implement this at all.
 */
export class WebuiErrorBoundary extends Component<
  WebuiErrorBoundaryProps,
  WebuiErrorBoundaryState
> {
  state: WebuiErrorBoundaryState = { error: undefined };

  static getDerivedStateFromError(error: unknown): WebuiErrorBoundaryState {
    return { error: describeWebuiBoundaryError(error) };
  }

  componentDidCatch(error: unknown, info: ErrorInfo): void {
    // The fallback is a recovery surface, not a sink. A throw that only painted
    // a message would be invisible to anyone without devtools and to error
    // reporting, so the cause is forwarded with the component stack — the only
    // thing that still says *where* it came from once the tree is gone.
    console.error(
      "[webui] uncaught render error:",
      describeWebuiBoundaryError(error),
      info.componentStack,
    );
  }

  /**
   * Clears the caught error so the children mount again. Public because the
   * retry button and any host that wants to recover from outside share this one
   * transition — two copies would drift.
   */
  resetErrorBoundary = (): void => {
    this.setState({ error: undefined });
    this.props.onReset?.();
  };

  render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <WebuiErrorBoundaryFallback
        error={error}
        title={this.props.title}
        detail={this.props.detail}
        retryLabel={this.props.retryLabel}
        onRetry={this.resetErrorBoundary}
      />
    );
  }
}
