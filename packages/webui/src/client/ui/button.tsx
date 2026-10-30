// The shared button contract (ADR 0028 § Shared contracts).
//
// A control enters the shared layer when two or more businesses use it with
// compatible semantics and states, it is business-independent, and one owner can
// write its states once. The button is the first application of that criterion:
// the settings business declared `.webui-mavis-button*` in its own stylesheet and
// the interactions business declared `.webui-button-primary/-secondary` in its
// own, so the same action looked different depending on where a user met it.
//
// This module owns the states and the appearance. A caller owns the layout,
// meaning and lifetime: it states a variant and a size, and puts its own layout
// in `className`. A difference that is control-owned and stable became a named
// variant — `danger` and `primary` are the two the client actually needed —
// rather than a per-caller class string.

import type { ButtonHTMLAttributes, ReactElement, ReactNode } from "react";

/** The variants the client's callers need today. */
export type WebuiButtonVariant = "secondary" | "primary" | "danger";

/**
 * The sizes the client's callers need today.
 *
 * `regular` is the standalone action, `compact` the row action beside a label,
 * and `header` the action that sits in a surface's header next to its title.
 * None of them carries a width: a caller's layout decides how wide the button is
 * allowed to be.
 */
export type WebuiButtonSize = "regular" | "compact" | "header";

const VARIANT_CLASS: Record<WebuiButtonVariant, string> = {
  secondary: "webui-mavis-button-gray",
  primary: "webui-mavis-button-black",
  danger: "webui-mavis-button-danger",
};

const SIZE_CLASS: Record<WebuiButtonSize, string> = {
  regular: "",
  compact: "webui-mavis-button-compact",
  header: "webui-mavis-button-header",
};

export interface WebuiButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "className"> {
  readonly variant: WebuiButtonVariant;
  readonly size?: WebuiButtonSize;
  /** The caller's layout only — never the control's states or appearance. */
  readonly className?: string;
  readonly children?: ReactNode;
}

/**
 * A button whose states belong to the shared layer.
 *
 * `type="button"` is the default on purpose: a shared control must not become a
 * form's submit button because a caller forgot to say so, and a caller that wants
 * submission says `type="submit"` explicitly.
 */
export function WebuiButton({
  variant,
  size = "regular",
  className,
  children,
  type = "button",
  ...rest
}: WebuiButtonProps): ReactElement {
  const classes = ["webui-mavis-button", VARIANT_CLASS[variant], SIZE_CLASS[size], className]
    .filter((entry) => Boolean(entry && entry.length > 0))
    .join(" ");
  return (
    <button type={type} className={classes} {...rest}>
      {children}
    </button>
  );
}

export interface WebuiIconButtonProps
  extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "className" | "children"> {
  /** The accessible name. An icon-only control has no text of its own. */
  readonly label: string;
  readonly className?: string;
  readonly children?: ReactNode;
}

/**
 * An icon-only button: the same ownership split, at the size a header or a row
 * uses for a glyph.
 *
 * The accessible name is required rather than optional, because an icon-only
 * control without one is exactly the case the accessibility obligations name.
 */
export function WebuiIconButton({
  label,
  className,
  children,
  type = "button",
  ...rest
}: WebuiIconButtonProps): ReactElement {
  const classes = ["webui-icon-button", className].filter(Boolean).join(" ");
  return (
    <button type={type} className={classes} aria-label={label} {...rest}>
      {children}
    </button>
  );
}
