// The settings page skeleton — one frame every settings page renders inside.
//
// Why this module exists: each settings page used to carry its own copy of the
// page frame (a centred column), its own section title, and its own card, and
// the copies drifted. The worktree page drew a bordered white card with a 10px
// radius where the general page drew a grouped-surface card with a 16px radius,
// so two pages in the same panel looked like two products. The skeleton is now
// declared once, here, and every page renders it: the general page's look is
// the reference, and the others adopt it.
//
// What belongs here is the *frame* — the column, the section title, the card,
// the row and the divider. What belongs to a page is the content inside the
// card: a mode card, a theme picker, a diff list, a session list. Those keep
// their own rules, because a page that renders a diff list should not have to
// pretend the diff list is a settings row.
//
// The module lives in `client/ui/` rather than in a business because the
// skeleton is shared: the settings business renders it, and so does the code
// review page, which is a different business' page shown inside the settings
// panel. A shared component in a shared layer is the only placement that lets
// both use it without one business reaching into another's private module.

import type { ReactElement, ReactNode } from "react";
import { WebuiButton } from "./button.js";

/**
 * The page frame: one centred column, the width every settings page shares.
 *
 * The width is the general page's own, so adopting this frame does not move
 * the page that already had it.
 *
 * `dataAttributes` carries the state markers a page publishes for its own
 * contract — the worktree page marks what it managed to read, for instance.
 * The skeleton does not know what those mean, so it only passes them through.
 */
export function SettingsPage({ children, testId, dataAttributes }: { readonly children: ReactNode; readonly testId?: string; readonly dataAttributes?: Readonly<Record<string, string>> }): ReactElement {
  return <div className="webui-settings-page" data-testid={testId} {...dataAttributes}>{children}</div>;
}

/**
 * One section: a title, an optional action, and the card the content sits in.
 *
 * `hint` is the section's help bubble and `actions` whatever the section
 * carries on the right of its title — a save button, a delete-all button. Both
 * are optional because a section that has neither still renders the same
 * frame: the title sits in the same place either way, which is the point.
 */
export function SettingsSection({
  title,
  testId,
  hint,
  hintTestId,
  actions,
  bare = false,
  children,
}: {
  readonly title: ReactNode;
  readonly testId?: string;
  readonly hint?: string;
  readonly hintTestId?: string;
  readonly actions?: ReactNode;
  /** A section whose content brings its own surface (a row of mode cards, a
   *  form) does not sit on the grouped card, so the card is dropped. */
  readonly bare?: boolean;
  readonly children: ReactNode;
}): ReactElement {
  return (
    <section className="webui-settings-section" data-testid={testId}>
      <div className="webui-settings-section-header">
        <div className="webui-settings-section-title">
          <h3>{title}</h3>
          {hint ? <InfoHint text={hint} testId={hintTestId ?? "webui-settings-section-hint"} /> : null}
        </div>
        {actions ? <div className="webui-settings-section-actions">{actions}</div> : null}
      </div>
      <div className={bare ? "webui-settings-card is-bare" : "webui-settings-card"}>{children}</div>
    </section>
  );
}

/**
 * The card itself, for a section whose content is not a list of rows.
 *
 * `SettingsSection` renders one of these already; this is for a page that
 * needs a second card inside the same section.
 */
export function SettingsCard({ children, className }: { readonly children: ReactNode; readonly className?: string }): ReactElement {
  return <div className={className ? `webui-settings-card ${className}` : "webui-settings-card"}>{children}</div>;
}

/**
 * One row inside a card: a title, an optional description, and a control.
 *
 * The description is the second line under the title, so a row that has one
 * reads as one sentence and a half rather than as two unrelated labels.
 *
 * `body` is the row's own content that does not fit the title/description
 * pair — a list of sessions under a worktree, say. It runs the width of the
 * card under the title line, which is why it is a separate slot rather than
 * part of the control.
 */
export function SettingsRow({
  title,
  description,
  body,
  children,
  testId,
  dataAttributes,
  disabled = false,
}: {
  readonly title: ReactNode;
  readonly description?: ReactNode;
  readonly body?: ReactNode;
  readonly children?: ReactNode;
  readonly testId?: string;
  readonly dataAttributes?: Readonly<Record<string, string>>;
  readonly disabled?: boolean;
}): ReactElement {
  return (
    <div data-testid={testId} {...dataAttributes} className={disabled ? "webui-settings-row is-disabled" : "webui-settings-row"} aria-disabled={disabled || undefined}>
      <div className="webui-settings-row-main">
        <div className="webui-settings-row-copy">
          <strong>{title}</strong>
          {description ? <span>{description}</span> : null}
        </div>
        <div className="webui-settings-row-control">{children}</div>
      </div>
      {body ? <div className="webui-settings-row-body">{body}</div> : null}
    </div>
  );
}

/** The hairline between two rows of the same card. */
export function SettingsDivider(): ReactElement {
  return <div className="webui-settings-divider"><span /></div>;
}

/**
 * The section title's help affordance.
 *
 * A real bubble rather than a native `title`: `title` cannot match the dark
 * bubble with an arrow this hangs above the glyph — the browser draws its own
 * surface, delays it about a second, and paints no arrow. The shape itself is
 * not new — `.webui-signin-credits-tooltip` and `.webui-context-usage-label`
 * already carry it, and this is another call site against the same object
 * rather than another design.
 *
 * Two decisions worth stating. It is a real `button`, not the `role="img"`
 * span it replaces, so the affordance is reachable by keyboard; the bubble is
 * `aria-hidden` because `aria-label` already reads as the control's name and a
 * `role="tooltip"` nothing references would be a second, dangling announcement
 * of the same sentence.
 */
export function InfoHint({ text, testId }: { readonly text: string; readonly testId: string }): ReactElement {
  return (
    <span className="webui-settings-info-hint-anchor">
      <WebuiButton variant="plain" size="inline" data-testid={testId} className="webui-settings-info-hint" aria-label={text}>
        i
      </WebuiButton>
      <span aria-hidden="true" className="webui-settings-info-hint-bubble">
        {text}
      </span>
    </span>
  );
}
