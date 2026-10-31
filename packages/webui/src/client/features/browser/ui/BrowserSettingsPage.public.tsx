// The browser settings page.
//
// The four switches and the bridge installation key used to hang under the
// browser panel, in the tool area. They are settings, and a setting that lives
// in a panel is a setting nobody finds without opening that panel first — so
// they moved to the Settings page, where the rest of the person's preferences
// already live.
//
// The page belongs to the browser business and is published, because the
// browser family owns the vocabulary: what a surface is, what Full CDP widens,
// and what the bridge key pairs with. The settings page mounts this; it does
// not restate what a switch means, because a second copy of that copy is a
// second answer to the same question.
//
// The owner is the browser family's, and it is the same owner the panel reads:
// a switch moved here reaches the panel in the tool area without the panel
// re-reading the host.

import { useCallback, useEffect, type ReactElement } from "react";

import { SettingsPage } from "../../../ui/settings-layout.js";
import {
  useWebuiBrowserAuthorization,
  useWebuiBrowserAuthorizationState,
} from "../bindings/use-browser-authorization.public.js";
import type { WebuiBrowserAuthorizationToggle } from "../contracts/browser-port.js";
import {
  BrowserAuthorizationSwitches,
  BrowserInstallationKey,
} from "./BrowserAuthorizationSwitches.public.js";

export function BrowserSettingsPage(): ReactElement {
  const owner = useWebuiBrowserAuthorization();
  const state = useWebuiBrowserAuthorizationState();

  // The read is the owner's, and it is asked for once per mount: a second
  // caller re-reads the same answer rather than keeping a second copy of it.
  useEffect(() => {
    void owner?.load();
  }, [owner]);

  const onChange = useCallback(
    (toggle: WebuiBrowserAuthorizationToggle): void => {
      void owner?.toggle(toggle);
    },
    [owner],
  );

  // Absent until a read lands. A switch with no baseline is disabled rather
  // than rendered off: an off switch says the host says so, and here nobody
  // has said anything yet.
  const authorization = state?.status === "ready" ? state.authorization : undefined;
  const disabled = state === undefined || !state.canWrite || state.pending;

  return (
    <SettingsPage testId="content-body">
      <BrowserAuthorizationSwitches
        authorization={authorization}
        onChange={onChange}
        disabled={disabled}
      />
      <BrowserInstallationKey
        readKey={state?.canReadInstallationKey && owner ? owner.readInstallationKey : undefined}
      />
    </SettingsPage>
  );
}
