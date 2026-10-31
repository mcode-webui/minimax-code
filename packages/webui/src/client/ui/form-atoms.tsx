// Small cross-business presentation atoms for icon-only form actions.

import type { ReactElement, ReactNode } from "react";
import { WebuiIconButton } from "./button.js";
import { IconRefresh, IconX } from "@tabler/icons-react";

export function IconButton({ label, disabled = false, onClick, children }: { readonly label: string; readonly disabled?: boolean; readonly onClick: () => void; readonly children: ReactNode }): ReactElement {
  // The icon-only control is the shared contract's, in its bare tone: this atom
  // used to carry its own class string, which is exactly the drift the contract
  // exists to stop.
  return <WebuiIconButton tone="bare" label={label} disabled={disabled} onClick={onClick}>{children}</WebuiIconButton>;
}

export function CloseIcon(): ReactElement {
  return <IconX aria-hidden="true" size={16} stroke={1.7} />;
}

export function RefreshIcon(): ReactElement {
  return <IconRefresh aria-hidden="true" size={16} stroke={1.7} />;
}
