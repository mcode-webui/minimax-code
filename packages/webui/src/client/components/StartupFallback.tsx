import type { ReactElement } from "react";

/**
 * The boot-failure surface for `main.tsx`.
 *
 * The error boundary cannot catch a boot failure: it lives inside the render
 * that never started. Before this component existed, a missing `#webui-root`
 * or a missing `__WEBUI_CONFIG__` threw from module top level and the user got
 * a white page — the exact failure the boundary was added to prevent, one
 * render too early for it to see. `main.tsx` renders this surface directly
 * instead of throwing, so the failure says what it is and offers the one
 * action that can fix both causes: load the page again.
 *
 * Deliberately dependency-free and presentational: `main.tsx` cannot assume
 * the transport, the config, or even the mount node exists, so this component
 * touches nothing beyond its props.
 */
export function WebuiStartupFallback({
  reason,
  detail,
  reloadLabel = "刷新重试",
  onReload,
}: {
  /** The technical cause, shown verbatim — the boot log is the diagnosis. */
  readonly reason: string;
  /** One sentence of plain language saying what the reader should do. */
  readonly detail: string;
  /** The single action's label, overridable the way the boundary's is. */
  readonly reloadLabel?: string;
  readonly onReload: () => void;
}): ReactElement {
  return (
    <section
      role="alert"
      data-testid="webui-startup-fallback"
      className="mx-auto flex min-h-screen max-w-xl flex-col items-center justify-center gap-spacing_8 p-spacing_24 text-center"
    >
      <h1 data-testid="webui-startup-fallback-title" className="text-2xl font-semibold">页面未能启动</h1>
      <p data-testid="webui-startup-fallback-detail" className="text-text_default_secondary">{detail}</p>
      {/* Same rule as the boundary's fallback: the message is shown, not just
       * logged, because this surface is the only place the cause survives —
       * there is no console guarantee on a machine where the page never
       * booted. */}
      <p
        data-testid="webui-startup-fallback-reason"
        className="max-w-full break-words font-mono text-text_default_tertiary"
      >
        {reason}
      </p>
      <button
        type="button"
        data-testid="webui-startup-fallback-reload"
        className="webui-button-secondary"
        onClick={onReload}
      >
        {reloadLabel}
      </button>
    </section>
  );
}
