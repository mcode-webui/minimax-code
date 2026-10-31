import type { ReactNode } from "react";

/** Layout wrapper only. `WebuiSessionTranscript` in `SessionTranscript.tsx`
 * owns the real transcript; this component survives solely to carry the
 * `transcript` data hook.
 *
 * It used to render a `messages` list through `WebuiMarkdown`. That branch was
 * superseded in `fe0ad4f` in favour of the `children` short-circuit below, and
 * the single call site has never passed `messages` — which is why the
 * `WebuiMarkdown` import that outlived the branch stayed here until now. */
export function Transcript({ children }: { readonly children: ReactNode }) {
  return <div data-webui-component="transcript" className="contents">{children}</div>;
}
