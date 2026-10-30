// The 远程 page's bodies.
//
// The page shell owns the tab; this module owns the mapping from the page's
// state to the business that fills it. Keeping the mapping here means the shell
// does not import either business, and each business stays a published surface
// that can also be mounted on its own.
//
// The owners arrive as props. This module is a view, and a view may not reach
// the composition root for them: the shell that owns the page passes the
// owners it already holds.
import type { ReactNode } from "react";

import { ChannelConnectPanel } from "../../channel/ui/ChannelConnectPanel.public.js";
import { RemoteControlPanel } from "../../remote-control/ui/RemoteControlPanel.public.js";
import { SshPanel } from "../../ssh/ui/SshPanel.public.js";
import type { WebuiRemoteSnapshot } from "../application/remote-owner.js";

export interface RemoteBodiesProps {
  readonly channelOwner: React.ComponentProps<typeof ChannelConnectPanel>["owner"];
  readonly remoteControlOwner: React.ComponentProps<typeof RemoteControlPanel>["owner"];
  readonly sshOwner: React.ComponentProps<typeof SshPanel>["owner"];
  /** Opens the SSH surface in place of the tab body. */
  readonly onOpenSsh: () => void;
}

export function renderRemoteBody({
  channelOwner,
  remoteControlOwner,
  sshOwner,
  onOpenSsh,
}: RemoteBodiesProps): (snapshot: WebuiRemoteSnapshot) => ReactNode {
  return (snapshot: WebuiRemoteSnapshot): ReactNode => {
    // The pairing page's SSH link opens the SSH surface in place of the tab body,
    // the way Desktop's link opens the SSH host management.
    if (snapshot.showSsh) {
      return <SshPanel owner={sshOwner} />;
    }
    switch (snapshot.activeTab) {
      case "im-connect":
        return <ChannelConnectPanel owner={channelOwner} />;
      case "remote-control":
      default:
        return (
          <RemoteControlPanel owner={remoteControlOwner} onOpenSsh={onOpenSsh} />
        );
    }
  };
}
