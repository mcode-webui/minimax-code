import { Component, type ErrorInfo, type ReactElement, type ReactNode } from "react";
import { describeWebuiBoundaryError } from "../features/shell/application/boundary-error.js";
import { WebuiButton } from "../ui/button.js";

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
  readonly onReset?: () => void | Promise<unknown>;
  /**
   * `panel` renders the recoverable state as a region inside a layout instead of
   * as the whole page. The root boundary owns the screen; a per-zone boundary
   * owns a column or a pane, and a `min-h-screen` fallback there would push the
   * rest of the app off the viewport — recovering from one broken panel by
   * losing sight of the others is not recovery.
   */
  readonly presentation?: "page" | "panel";
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
  presentation = "page",
}: {
  readonly error: Error;
  readonly title?: string;
  readonly detail?: string;
  readonly retryLabel?: string;
  readonly onRetry: () => void;
  readonly presentation?: "page" | "panel";
}): ReactElement {
  const page = presentation === "page";
  return (
    <section
      role="alert"
      data-testid="webui-error-boundary"
      className={
        page
          ? "mx-auto flex min-h-screen max-w-xl flex-col items-center justify-center gap-spacing_8 p-spacing_24 text-center"
          : "flex h-full min-h-0 w-full flex-col items-center justify-center gap-spacing_4 overflow-auto p-spacing_8 text-center"
      }
    >
      <h1 data-testid="webui-error-boundary-title" className={page ? "text-2xl font-semibold" : "text-base font-medium"}>{title}</h1>
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
      <WebuiButton variant="grouped" size="pill" data-testid="webui-error-boundary-retry"
        onClick={onRetry}
      >
        {retryLabel}
      </WebuiButton>
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
    const reset = (): void => this.setState({ error: undefined });
    const result = this.props.onReset?.();
    if (result && typeof (result as Promise<unknown>).then === "function") {
      void (result as Promise<unknown>).then(reset, reset);
      return;
    }
    reset();
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
        presentation={this.props.presentation}
        onRetry={this.resetErrorBoundary}
      />
    );
  }
}
