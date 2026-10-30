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

/**
 * The panel frame: a header slot, a body, and the one boundary the body scrolls at.
 *
 * The frame owns the column, where the header sits and where the scroll happens.
 * The business owns what the header says — a title and two buttons on one panel, a
 * row of tabs on another — and owns the body's content, its lifetime and its
 * commands. That split is what lets two pages with different headers share a
 * frame, which a title-and-actions component could not express.
 *
 * `scroll={false}` is for a page whose body must fill its height without scrolling
 * (a terminal, an embedded browser): the page then owns its own boundary, and the
 * frame guarantees there is still exactly one.
 */
export function PanelFrame({
  header,
  children,
  scroll = true,
  testId,
  ariaLabel,
  dataAttributes,
  className,
  headerClassName,
  bodyClassName,
}: {
  /** The page's header content. The business writes it; the frame places it. */
  readonly header?: ReactNode;
  readonly children: ReactNode;
  /** Whether the frame's own body scrolls. */
  readonly scroll?: boolean;
  readonly testId?: string;
  readonly ariaLabel?: string;
  readonly dataAttributes?: Readonly<Record<string, string>>;
  /** Extra classes for the column — a page that flexes inside a row, for instance. */
  readonly className?: string;
  /**
   * The page's own header chrome.
   *
   * A page whose header is not the standard title row — the remote page's tab
   * strip is a 46px bar with no divider — says so, and the frame still decides
   * where the header sits and that the body owns the scroll.
   */
  readonly headerClassName?: string;
  /** The page's own body chrome, when its content brings its own boundary. */
  readonly bodyClassName?: string;
}): ReactElement {
  return (
    <section
      {...(ariaLabel === undefined ? {} : { "aria-label": ariaLabel })}
      {...(testId === undefined ? {} : { "data-testid": testId })}
      {...(dataAttributes ?? {})}
      className={`flex h-full min-h-0 flex-col bg-bg_default_primary${className ? ` ${className}` : ""}`}
    >
      {header === undefined ? null : (
        <header
          className={
            headerClassName ??
            "flex flex-shrink-0 items-center justify-between border-b-[0.5px] border-border_default px-5 py-3"
          }
        >
          {header}
        </header>
      )}
      <div
        className={
          bodyClassName ??
          (scroll
            ? "webui-rail-scroll min-h-0 flex-1 overflow-y-auto px-5 py-3"
            : "flex min-h-0 flex-1 flex-col")
        }
      >
        {children}
      </div>
    </section>
  );
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
  // The title-and-actions page is the panel frame with one particular header: the
  // frame owns the column and the scroll, this owns the words and the buttons.
  return (
    <PanelFrame
      scroll={scroll}
      testId={testId}
      ariaLabel={ariaLabel}
      dataAttributes={dataAttributes}
      header={
        <>
          <h1 className="min-w-0 truncate text-base font-medium text-text_default_primary">{title}</h1>
          {actions === undefined ? null : <div className="flex items-center gap-2">{actions}</div>}
        </>
      }
    >
      {children}
    </PanelFrame>
  );
}
