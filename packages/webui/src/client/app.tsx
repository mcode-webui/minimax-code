// Minimal React component for the WebUI client foundation. Nothing
// user-visible renders here yet; ticket 01 is the package scaffold.

import type { ReactElement } from "react";

export interface WebuiClientFoundationAppProps {
  readonly label: string;
}

export function WebuiClientFoundationApp({
  label,
}: WebuiClientFoundationAppProps): ReactElement {
  return (
    <div data-webui-foundation={label} hidden={true}>
      {label}
    </div>
  );
}
