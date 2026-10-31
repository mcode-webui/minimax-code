import type { ReactNode } from "react";

/** Layout wrapper only. `WebuiComposer` in `SessionComposer.tsx` owns the real
 * composer; this component survives solely to carry the `composer` data hook
 * the shell grid hangs its measurement off.
 *
 * It used to be a standalone form with its own draft state, textarea and send
 * button. That implementation was superseded in `fe0ad4f`, the same commit
 * that introduced the `children` short-circuit below — so the form branch was
 * unreachable from the day it was written, and no call site has passed
 * `onSubmit` or `disabled` since. */
export function Composer({ children }: { readonly children: ReactNode }) {
  return <div data-webui-component="composer" className="contents">{children}</div>;
}
