// The content page frame (ADR 0028 § Shared contracts, #291).
//
// A page in this client is a full-height column with three things in a fixed
// order: a title with its actions, a body, and the boundary where the body
// scrolls. Two panels — 定时任务 and SSH — carried the same three things in
// identical markup, down to the header's border and the body's padding, and both
// are adopted here. A page that only shares colours with another is not a page of
// this family: the test for adoption is that the title and its actions mean the
// same thing, the column sizes the same way against the available width, and the
// same element owns the scroll.
//
// What the frame owns: the column, the header row with its title and action
// region, and the scroll boundary.
//
// What the page keeps: its own title text, its own actions, its own content, its
// own lifetime and every command behind its buttons.

import type { ReactElement, ReactNode } from "react";

export interface ContentPageProps {
  /** The page's heading. One line: the header truncates rather than wraps. */
  readonly title: ReactNode;
  /** The controls on the right of the title. */
  readonly actions?: ReactNode;
  /**
   * Whether the body scrolls.
   *
   * A page whose body must fill its height without scrolling — a terminal, an
   * embedded browser — turns this off and owns its own boundary. The scroll
   * belongs to exactly one element either way, which is what keeps a nested
   * region from scrolling the page instead of itself.
   */
  readonly scroll?: boolean;
  readonly testId?: string;
  /** Accessibility name for the region. Defaults to the title's text. */
  readonly ariaLabel?: string;
  /** The page's own markers, passed through untouched. */
  readonly dataAttributes?: Readonly<Record<string, string>>;
  readonly children: ReactNode;
}

/** A page: title and actions, then a body with one explicit scroll boundary. */
export function ContentPage({
  title,
  actions,
  scroll = true,
  testId,
  ariaLabel,
  dataAttributes,
  children,
}: ContentPageProps): ReactElement {
  return (
    <section
      {...(ariaLabel === undefined ? {} : { "aria-label": ariaLabel })}
      {...(testId === undefined ? {} : { "data-testid": testId })}
      {...(dataAttributes ?? {})}
      className="flex h-full min-h-0 flex-col bg-bg_default_primary"
    >
      <header className="flex flex-shrink-0 items-center justify-between border-b-[0.5px] border-border_default px-5 py-3">
        <h1 className="min-w-0 truncate text-base font-medium text-text_default_primary">{title}</h1>
        {actions === undefined ? null : <div className="flex items-center gap-2">{actions}</div>}
      </header>
      <div
        className={
          scroll
            ? "webui-rail-scroll min-h-0 flex-1 overflow-y-auto px-5 py-3"
            : "flex min-h-0 flex-1 flex-col"
        }
      >
        {children}
      </div>
    </section>
  );
}
