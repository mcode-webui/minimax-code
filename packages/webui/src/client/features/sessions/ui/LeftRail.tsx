import type { ReactNode } from "react";

/**
 * The rail's frame.
 *
 * The rail's contents are composed by the shell, so this owns the landmark and
 * its data attribute and nothing else. It used to carry a second body — a "New
 * session" button, a list of unwired entries and a session list — that
 * rendered only when no `children` were passed, and the one call site always
 * passes them. The four props that fed it were passed by nobody who read them.
 */
export function LeftRail({ children }: { readonly children: ReactNode }) {
  return <div data-webui-component="left-rail" className="contents">{children}</div>;
}
