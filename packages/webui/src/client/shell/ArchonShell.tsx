import type { ReactNode } from "react";

/** Layout wrapper only — the real two-column shell is assembled inline in
 * `WebuiClientFoundationApp`, which renders the rail itself and passes just
 * `children` here.
 *
 * It used to carry a `rail`-driven `aside`/`main` branch as well. That branch
 * was unreachable — the single call site never passed `rail`, so the shell
 * rendered through the `contents` short-circuit since introduction — and it has
 * been removed. Note that `.webui-rail` stays in the stylesheet regardless: the
 * live rail markup uses that class too. */
export function ArchonShell({ children }: { readonly children: ReactNode }) {
  return <div data-webui-archon-shell="true" className="contents">{children}</div>;
}
