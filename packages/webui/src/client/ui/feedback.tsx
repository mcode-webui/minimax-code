// The feedback family (ADR 0028 § Shared contracts, #292).
//
// Six things a surface can tell a user, which the client used to tell with four
// different spinners and a scattering of `role="alert"`:
//
//   FeedbackEmpty        nothing here yet, and what to do about it
//   FeedbackError        something failed, announced, with a way to retry
//   FeedbackSkeleton     content is coming; the shape of it, not a number
//   FeedbackProgress     a determinate amount of work, as `progressbar`
//   FeedbackBusy         work is happening, amount unknown, as `status`
//   FeedbackAnnouncement a live message with no visual state at all
//
// Why they are separate components rather than one with props: a determinate bar
// and an indeterminate indicator mean different things, and one component that
// renders both invites the wrong one. A progressbar that reports no value tells
// assistive technology nothing; a status that reports a percentage floods the live
// region with updates nobody asked for. An announcement is neither: it has no
// visual form, so it cannot be reached by a sighted user instead of a state.
//
// What belongs here: the contract — the role, the ARIA, the announcement policy.
// What belongs to the business: the words, the retry command, the amount.

import type { ReactElement, ReactNode } from "react";

/** Nothing here yet, and what a user can do about it. Not announced: it is a state. */
export function FeedbackEmpty({
  title,
  description,
  action,
  testId,
}: {
  readonly title: ReactNode;
  readonly description?: ReactNode;
  readonly action?: ReactNode;
  readonly testId?: string;
}): ReactElement {
  return (
    <div className="webui-feedback webui-feedback--empty" data-testid={testId}>
      <p className="webui-feedback-title">{title}</p>
      {description === undefined ? null : <p className="webui-feedback-description">{description}</p>}
      {action === undefined ? null : <div className="webui-feedback-action">{action}</div>}
    </div>
  );
}

/**
 * Something failed.
 *
 * `role="alert"` announces it once, when it appears. The `id` is what a control
 * points at with `aria-describedby`, so the message is reachable again afterwards
 * instead of only having been heard once — and a caller that shows the error next
 * to its own control passes the same id rather than announcing a second time.
 */
export function FeedbackError({
  message,
  action,
  id,
  testId,
  className,
  layout = "stacked",
  dataAttributes,
}: {
  readonly message: ReactNode;
  readonly action?: ReactNode;
  /** The id a control associates with `aria-describedby`. */
  readonly id?: string;
  readonly testId?: string;
  /** The surface's own classes, for a place whose error has its own chrome. */
  readonly className?: string;
  /** How the error and its retry action sit together. */
  readonly layout?: "stacked" | "inline";
  /** The surface's own markers, passed through untouched. */
  readonly dataAttributes?: Readonly<Record<string, string>>;
}): ReactElement {
  return (
    <div
      className={`webui-feedback webui-feedback--error${layout === "inline" ? " webui-feedback--inline" : ""}${className ? ` ${className}` : ""}`}
      role="alert"
      id={id}
      data-testid={testId}
      {...(dataAttributes ?? {})}
    >
      <p className="webui-feedback-title">{message}</p>
      {action === undefined ? null : <div className="webui-feedback-action">{action}</div>}
    </div>
  );
}

/**
 * Content is coming, in the shape it will arrive.
 *
 * The skeleton itself is decoration (`aria-hidden`): a screen reader should hear
 * "正在加载", not the outline of a card. The label sits in a `status` region so it
 * is announced once without being a second visual state.
 */
export function FeedbackSkeleton({
  label = "正在加载",
  rows = 3,
  testId,
}: {
  readonly label?: string;
  readonly rows?: number;
  readonly testId?: string;
}): ReactElement {
  return (
    <div className="webui-feedback webui-feedback--skeleton" data-testid={testId}>
      <p className="webui-feedback-sr" role="status">
        {label}
      </p>
      <div aria-hidden="true" className="webui-feedback-skeleton-body">
        {Array.from({ length: rows }, (_, index) => (
          <span key={index} className="webui-feedback-skeleton-row" />
        ))}
      </div>
    </div>
  );
}

/**
 * A determinate amount of work.
 *
 * `progressbar` carries a value, a range and a name. `value` is required: a
 * progressbar without one is an indeterminate indicator wearing the wrong role,
 * which is what `FeedbackBusy` is for.
 *
 * `children` replaces the default single fill with a caller's own segments. A
 * bar that shows a *breakdown* — how much of a context window each kind of
 * content took — cannot be drawn as one fill, but the role, the range and the
 * name are the same contract either way, and those must not be written twice.
 */
export function FeedbackProgress({
  label,
  value,
  max = 100,
  testId,
  className,
  children,
  indeterminate = false,
}: {
  readonly label: string;
  readonly value: number;
  readonly max?: number;
  readonly testId?: string;
  /** The surface's own classes. */
  readonly className?: string;
  /** The caller's own segments, in place of the single default fill. */
  readonly children?: ReactNode;
  /**
   * A bar whose amount is not known.
   *
   * The role, the range and the name still describe what the bar is; only the
   * value is withheld, because reporting one would state something the surface
   * does not know. A bar that shows a breakdown still shows it — the segments
   * are the caller's own — but the *share* is left unsaid.
   */
  readonly indeterminate?: boolean;
}): ReactElement {
  const clamped = Math.max(0, Math.min(value, max));
  const percent = max === 0 ? 0 : Math.round((clamped / max) * 100);
  return (
    <div
      className={`webui-feedback webui-feedback--progress${className ? ` ${className}` : ""}`}
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={max}
      {...(indeterminate ? {} : { "aria-valuenow": clamped, "aria-valuetext": `${percent}%` })}
      data-testid={testId}
    >
      <span aria-hidden="true" className="webui-feedback-progress-track">
        {children ?? <span className="webui-feedback-progress-fill" style={{ width: `${percent}%` }} />}
      </span>
    </div>
  );
}

/**
 * Work is happening and the amount is unknown.
 *
 * A `status` region with a label and no numbers. It is announced politely, once,
 * and it deliberately does not report a percentage: that is what `FeedbackProgress`
 * is for, and a status that updates continuously floods the live region.
 */
export function FeedbackBusy({
  label = "正在处理",
  testId,
  className,
}: {
  readonly label?: string;
  readonly testId?: string;
  /** The surface's own classes, for a place whose busy state has its own chrome. */
  readonly className?: string;
}): ReactElement {
  return (
    <div className={`webui-feedback webui-feedback--busy${className ? ` ${className}` : ""}`} role="status" data-testid={testId}>
      <span aria-hidden="true" className="webui-feedback-spinner" />
      <span className="webui-feedback-busy-label">{label}</span>
    </div>
  );
}

/**
 * A live message with no visual state.
 *
 * For a change a user needs to hear but not to see — "已复制", "已保存" — the
 * region is visually hidden, which is the point: an announcement used as a visual
 * state stops being an announcement and becomes a banner nobody asked for.
 */
export function FeedbackAnnouncement({
  message,
  politeness = "polite",
}: {
  readonly message: ReactNode;
  readonly politeness?: "polite" | "assertive";
}): ReactElement {
  return (
    <p className="webui-feedback-sr" aria-live={politeness} aria-atomic="true">
      {message}
    </p>
  );
}

/**
 * A live region the reader can also see.
 *
 * `FeedbackAnnouncement` is for a change with no visual form. But a surface whose
 * *state* is the thing being announced — a connection's state, a queue's state, a
 * goal's state — has to stay visible, because the state is not a message about
 * the surface, it *is* the surface. The region's own content changes, and the
 * change is what a screen reader should hear.
 *
 * Eight surfaces wrote this by hand, each with its own spelling of the same
 * three attributes: a `role="status"`, an `aria-live="polite"`, and content that
 * was sometimes replaced and sometimes appended to. A live region that is
 * appended to announces only the addition, so a reader could hear "已连接" and
 * never learn that the state before it was "连接中" — which is why this contract
 * owns `aria-atomic` as well, and why the region always renders and only its
 * content changes.
 *
 * What belongs here: the role, the announcement policy, the atomicity. What
 * belongs to the business: the words, the appearance, and what the state means.
 */
export function FeedbackLiveRegion({
  children,
  politeness = "polite",
  className,
  testId,
  dataAttributes,
}: {
  readonly children: ReactNode;
  readonly politeness?: "polite" | "assertive";
  /** The surface's own classes. */
  readonly className?: string;
  readonly testId?: string;
  readonly dataAttributes?: Readonly<Record<string, string>>;
}): ReactElement {
  return (
    <div
      className={className}
      role="status"
      aria-live={politeness}
      aria-atomic="true"
      data-testid={testId}
      {...(dataAttributes ?? {})}
    >
      {children}
    </div>
  );
}
