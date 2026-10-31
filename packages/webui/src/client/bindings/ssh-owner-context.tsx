// The SSH owner's binding.
//
// One owner, two homes: the settings page's `连接` tab (where Desktop puts
// `设置 > 连接 > SSH`) and the 远程 page's SSH entry. A context keeps it one
// instance — a second owner over the same slice would be a second authority for
// the same hosts, and the two panels would then disagree about a host's status.
import { createContext, useContext, type ReactNode } from "react";

import type { WebuiSshOwner } from "../features/ssh/application/ssh-owner.js";

const SshOwnerContext = createContext<WebuiSshOwner | null>(null);

export function WebuiSshOwnerProvider({
  owner,
  children,
}: {
  readonly owner: WebuiSshOwner;
  readonly children: ReactNode;
}) {
  return <SshOwnerContext.Provider value={owner}>{children}</SshOwnerContext.Provider>;
}

/**
 * The SSH owner, or `null` where no host has been wired.
 *
 * `null` means "this surface has no SSH", not "there are no hosts" — the panel
 * says so itself rather than rendering an empty list.
 */
export function useWebuiSshOwner(): WebuiSshOwner | null {
  return useContext(SshOwnerContext);
}
