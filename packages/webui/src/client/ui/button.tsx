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

import {
  forwardRef,
  type AnchorHTMLAttributes,
  type ButtonHTMLAttributes,
  type ReactElement,
  type ReactNode,
} from "react";

/**
 * The variants the client's callers need today.
 *
 * A variant is a whole appearance: the fill, the border, the label colour and
 * the states that belong to that appearance. A caller states one and the
 * contract owns the rest — which is why a caller outside this directory may not
 * spell the recipe instead.
 */
export type WebuiButtonVariant =
  | "secondary"
  | "surface"
  | "primary"
  | "muted"
  | "danger"
  | "plain"
  // The inline appearances: a hairline ring, or no ring at all.
  | "outline"
  | "outline-secondary"
  | "outline-highlight"
  | "quiet-highlight"
  | "quiet-secondary"
  | "quiet-subtle"
  // The two appearances four businesses each used to declare for themselves.
  | "accent"
  | "grouped";

/**
 * The sizes the client's callers need today.
 *
 * `regular` is the standalone action, `compact` the row action beside a label,
 * and `header` the action that sits in a surface's header next to its title.
 * None of them carries a width: a caller's layout decides how wide the button is
 * allowed to be.
 *
 * The inline sizes state no height on purpose: their callers sized the control
 * by its label, its padding and its border, and a stated height would squeeze
 * the ringed ones by the two pixels their border takes.
 */
export type WebuiButtonSize =
  | "regular"
  | "compact"
  | "header"
  | "panel"
  | "dialog"
  | "inline"
  | "inline-dense"
  | "inline-tiny"
  | "action"
  | "pill";

const VARIANT_CLASS: Record<WebuiButtonVariant, string> = {
  secondary: "webui-mavis-button-gray",
  // `surface` is the fill of the surface the button sits on: white on a grouped
  // panel. The plugin forms' action rows use it, and it is a variant because the
  // fill is the control's, not the caller's.
  surface: "webui-mavis-button-surface",
  primary: "webui-mavis-button-black",
  // `muted` is the filled-but-quiet save the forms use: a surface's primary
  // action that does not shout. Two forms render it, so it is a named variant
  // rather than a class string each of them writes.
  muted: "webui-mavis-button-muted",
  danger: "webui-mavis-button-danger",
  // `plain` is the button a surface already styles as "a button, no fill" — the
  // contract owns its states (focus, disabled) and the caller owns the rest.
  plain: "webui-mavis-button-plain",
  // The ringed inline action. Three businesses wrote this ring and its label
  // as a utility class string each; the ring is the control's.
  outline: "webui-mavis-button-outline",
  // The same ring with the quieter label.
  "outline-secondary": "webui-mavis-button-outline-secondary",
  // The same ring with the quieter label that comes forward on hover.
  "outline-highlight": "webui-mavis-button-outline-highlight",
  // The ringless inline action whose quieter label comes forward on hover.
  "quiet-highlight": "webui-mavis-button-quiet-highlight",
  // The ringless inline action with the quieter label.
  "quiet-secondary": "webui-mavis-button-quiet-secondary",
  // The ringless inline action with the quietest label.
  "quiet-subtle": "webui-mavis-button-quiet-subtle",
  // The filled call to action: the interactions business's `.webui-button-primary`,
  // which the account, transcript, composer, workspace and shell businesses also
  // rendered.
  accent: "webui-mavis-button-accent",
  // The grouped pill: the interactions business's `.webui-button-secondary`, which
  // the same five businesses also rendered.
  grouped: "webui-mavis-button-grouped",
};

const SIZE_CLASS: Record<WebuiButtonSize, string> = {
  regular: "webui-mavis-button-regular",
  compact: "webui-mavis-button-compact",
  header: "webui-mavis-button-header",
  // The plugin surfaces' two action rows, kept apart because they are two sizes
  // rather than one size two callers disagree about.
  panel: "webui-mavis-button-panel",
  dialog: "webui-mavis-button-dialog",
  // The three inline scales.
  inline: "webui-mavis-button-inline",
  "inline-dense": "webui-mavis-button-inline-dense",
  "inline-tiny": "webui-mavis-button-inline-tiny",
  // The filled call to action's geometry; it pairs with the `accent` variant.
  action: "webui-mavis-button-action",
  // The grouped pill's geometry; it pairs with the `grouped` variant.
  pill: "webui-mavis-button-pill",
};

/**
 * The class string one appearance is rendered with.
 *
 * The button and the link that looks like one share it, which is what makes
 * them the same control rather than two controls that agree today.
 */
function buttonClasses(variant: WebuiButtonVariant, size: WebuiButtonSize, className?: string): string {
  return ["webui-mavis-button", VARIANT_CLASS[variant], SIZE_CLASS[size], className]
    .filter((entry) => Boolean(entry && entry.length > 0))
    .join(" ");
}

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
// Forwarded refs are part of the contract, not an extra: a button that opens a
// dropdown is a trigger, and a trigger has to hand its element to the popup.
export const WebuiButton = forwardRef<HTMLButtonElement, WebuiButtonProps>(function WebuiButton(
  { variant, size = "regular", className, children, type = "button", ...rest },
  ref,
): ReactElement {
  const classes = buttonClasses(variant, size, className);
  return (
    <button ref={ref} type={type} className={classes} {...rest}>
      {children}
    </button>
  );
});

export interface WebuiButtonLinkProps
  extends Omit<AnchorHTMLAttributes<HTMLAnchorElement>, "className"> {
  readonly variant: WebuiButtonVariant;
  readonly size?: WebuiButtonSize;
  /** The caller's layout only — never the control's states or appearance. */
  readonly className?: string;
  readonly children?: ReactNode;
}

/**
 * A link that looks like a button.
 *
 * It is the same contract and the same appearance: a caller that navigates
 * cannot render a `<button>`, and a caller that acts cannot render an `<a>`.
 * Two callers — the workspace's HTML preview and the shell's not-found page —
 * reached for the same button appearance on an anchor, and each of them spelled
 * it as the class string of a business that owned it.
 */
export const WebuiButtonLink = forwardRef<HTMLAnchorElement, WebuiButtonLinkProps>(
  function WebuiButtonLink({ variant, size = "regular", className, children, ...rest }, ref): ReactElement {
    return (
      <a ref={ref} className={buttonClasses(variant, size, className)} {...rest}>
        {children}
      </a>
    );
  },
);

export interface WebuiIconButtonProps
  extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "className" | "children"> {
  /** The accessible name. An icon-only control has no text of its own. */
  readonly label: string;
  /**
   * Which surface the glyph sits on: `surface` is the filled box a header uses,
   * `bare` the no-fill control a field row uses. Both are this contract's.
   */
  readonly tone?: "surface" | "bare";
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
export const WebuiIconButton = forwardRef<HTMLButtonElement, WebuiIconButtonProps>(
  function WebuiIconButton(
    { label, tone = "surface", className, children, type = "button", ...rest },
    ref,
  ): ReactElement {
    const classes = [
      "webui-icon-button",
      tone === "bare" ? "webui-icon-button--bare" : "",
      className,
    ]
      .filter(Boolean)
      .join(" ");
    return (
      <button ref={ref} type={type} className={classes} aria-label={label} {...rest}>
        {children}
      </button>
    );
  },
);
