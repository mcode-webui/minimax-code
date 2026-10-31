// The shared menu-item contract (ADR 0028 § Shared contracts).
//
// A menu row is a control: it is a button that means "choose this", it has a
// hover state, a focus ring, a disabled state, and — when the choice is
// destructive — a danger state. Four businesses declared that control in
// their own stylesheets before this contract existed:
//
//   `.webui-context-menu-item`      shell.css
//   `.webui-user-menu-item`         account.css
//   `.webui-composer-menu button`   composer.css
//   `.webui-memory-manager-menu-item` settings.css
//
// The four were close enough that a reader could not tell whether they were
// the same control, which is the test ADR 0028 states for admission: "two or
// more businesses use it with compatible semantics and states". They did not,
// because each of them re-derived the row: the height, the radius, the gap,
// the icon slot and the trailing slot were each written again.
//
// So the row lives here. This module owns the states and the arrangement; a
// caller owns the meaning, the destination and the lifetime. A caller that
// needs a different arrangement says so in `className` — the same split the
// button contract uses.
//
// The two slots are the reason this is a component rather than a class name.
// Every one of those four rows had the same two optional parts: a leading
// glyph and a trailing affordance (a shortcut hint, a chevron). They were
// written as sibling spans with per-business class names, so the slots were
// invisible to a reader looking for one. Naming them here makes the row's
// shape legible: a glyph, a label, and something after the label.

import type { ButtonHTMLAttributes, ReactElement, ReactNode } from "react";

export interface WebuiMenuItemProps
  extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "className" | "children"> {
  /** The row's own text. */
  readonly children: ReactNode;
  /** A leading glyph. Decorative by default: the label is the row's name. */
  readonly icon?: ReactNode;
  /**
   * What sits after the label — a shortcut hint, a chevron, a count.
   *
   * It is pushed to the far edge of the row, so the label stays in one place
   * whether a row has a trailing part or not.
   */
  readonly trailing?: ReactNode;
  /** A choice that undoes something. */
  readonly danger?: boolean;
  /** The caller's layout only — never the control's states or appearance. */
  readonly className?: string;
}

/**
 * A row in a menu.
 *
 * `type="button"` is the default on purpose: a shared control must not become a
 * form's submit button because a caller forgot to say so.
 *
 * A disabled row carries `aria-disabled` as well as the native `disabled`. The
 * native attribute already removes the row from the tab order and stops the
 * click, but a menu is a `menu` role: assistive technology reads a `menu`'s
 * items as a list it can still be reading, and `aria-disabled` is what tells
 * it the row is there but unavailable. Both together are what a reader needs
 * to hear the row rather than have it silently vanish.
 */
export function WebuiMenuItem({
  children,
  icon,
  trailing,
  danger = false,
  className,
  type = "button",
  disabled,
  ...rest
}: WebuiMenuItemProps): ReactElement {
  const classes = ["webui-menu-item", danger ? "webui-menu-item--danger" : "", className]
    .filter((entry) => Boolean(entry && entry.length > 0))
    .join(" ");
  return (
    <button
      type={type}
      role="menuitem"
      className={classes}
      disabled={disabled}
      aria-disabled={disabled ? "true" : undefined}
      {...rest}
    >
      {icon ? (
        <span className="webui-menu-item-icon" aria-hidden="true">
          {icon}
        </span>
      ) : null}
      <span className="webui-menu-item-label">{children}</span>
      {trailing ? <span className="webui-menu-item-trailing">{trailing}</span> : null}
    </button>
  );
}

/**
 * A separator between groups of rows.
 *
 * It is a `separator` role rather than a styled div, because the gap between
 * two groups of choices is a meaning, not a line.
 */
export function WebuiMenuSeparator(): ReactElement {
  return <div className="webui-menu-separator" role="separator" />;
}
