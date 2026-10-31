// Shared layout primitives (ADR 0028 § Structural patterns).
//
// These are for repeated, content-independent arrangements. A caller states
// direction, alignment and a named spacing step; feature styles remain on the
// content that makes that layout unique rather than re-declaring the layout.

import { createElement, type HTMLAttributes, type ReactElement, type ReactNode } from "react";

export type WebuiLayoutGap = "none" | "hairline" | "micro" | "tight" | "compact" | "small" | "medium" | "roomy" | "large";
export type WebuiLayoutAlignment = "start" | "center" | "end" | "stretch" | "baseline";
export type WebuiLayoutJustification = "start" | "center" | "end" | "between";
export type WebuiInlineElement = "div" | "label" | "main" | "span" | "ul";
export type WebuiStackElement = "div" | "li" | "section" | "ul" | "ol";

interface WebuiLayoutProps extends Omit<HTMLAttributes<HTMLElement>, "className"> {
  readonly gap?: WebuiLayoutGap;
  readonly align?: WebuiLayoutAlignment;
  /** Business-specific hooks or styles only; shared layout stays in props. */
  readonly className?: string;
  readonly children: ReactNode;
}

export interface WebuiInlineProps extends WebuiLayoutProps {
  readonly inline?: boolean;
  readonly wrap?: boolean;
  readonly justify?: WebuiLayoutJustification;
  readonly as?: WebuiInlineElement;
}

export interface WebuiStackProps extends WebuiLayoutProps {
  readonly as?: WebuiStackElement;
  readonly justify?: WebuiLayoutJustification;
}

/** A horizontal group with shared alignment and spacing. */
export function WebuiInline({
  gap = "none",
  inline = false,
  align = "center",
  wrap = false,
  justify = "start",
  as = "div",
  className,
  children,
  ...rest
}: WebuiInlineProps): ReactElement {
  return createElement(
    as,
    {
      className: [
        "webui-inline",
        `webui-inline--gap-${gap}`,
        inline ? "webui-inline--inline" : "",
        `webui-inline--align-${align}`,
        `webui-inline--justify-${justify}`,
        wrap ? "webui-inline--wrap" : "",
        className,
      ].filter(Boolean).join(" "),
      ...rest,
    },
    children,
  );
}

/** A vertical group with shared alignment and spacing. */
export function WebuiStack({
  gap = "none",
  align = "stretch",
  justify = "start",
  as = "div",
  className,
  children,
  ...rest
}: WebuiStackProps): ReactElement {
  return createElement(
    as,
    {
      className: [
        "webui-stack",
        `webui-stack--gap-${gap}`,
        `webui-stack--align-${align}`,
        `webui-stack--justify-${justify}`,
        className,
      ].filter(Boolean).join(" "),
      ...rest,
    },
    children,
  );
}
