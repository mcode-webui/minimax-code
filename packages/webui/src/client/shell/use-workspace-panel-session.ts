/**
 * The workspace panel's per-session state and its two dispatch affordances.
 *
 * The panel owner holds one state per session and notifies subscribers; the shell
 * subscribes for the session it currently shows rather than reading once, and
 * both writers refuse to act without a selected session (there is no session to
 * key the state by).
 *
 * Extracted from `WebuiClientFoundationApp.tsx`: this is the panel's session
 * wiring, and it changes when the panel's state machine or its queries change —
 * not when the shell's layout does.
 */
import { useCallback, useSyncExternalStore } from "react";

import {
  initialWorkspacePanelSessionState,
  type WorkspacePanelCommand,
  type WorkspacePanelSessionState,
} from "../features/workspace/projection/workspace-panel-state.js";

/**
 * What the hook needs from the panel owner, stated as the surface it uses rather
 * than by importing the owner's type: the shell may not reach into the assembly
 * that composes it (role rule), and the owner is handed down as a capability.
 */
export interface WorkspacePanelOwnerView {
  readonly subscribe: (listener: () => void) => () => void;
  readonly stateFor: (sessionId: string) => WorkspacePanelSessionState;
  readonly dispatch: (sessionId: string, command: WorkspacePanelCommand) => void;
  readonly setProgressPanelOpen: (sessionId: string, open: boolean) => void;
}

export interface WorkspaceQueriesView {
  readonly discardFileTab: (tabId: string) => void;
}

export interface UseWorkspacePanelSessionOptions {
  readonly owner: WorkspacePanelOwnerView;
  readonly queries: WorkspaceQueriesView;
  readonly selectedSessionId: string | undefined;
}

export interface WorkspacePanelSession {
  readonly sessionPanelState: WorkspacePanelSessionState;
  readonly workspacePanel: WorkspacePanelSessionState["workspacePanel"];
  readonly progressPanelOpen: boolean;
  readonly dispatchWorkspacePanel: (command: WorkspacePanelCommand) => void;
  readonly setProgressPanelOpen: (update: boolean | ((open: boolean) => boolean)) => void;
}

export function useWorkspacePanelSession(
  options: UseWorkspacePanelSessionOptions,
): WorkspacePanelSession {
  const { owner, queries, selectedSessionId } = options;

  // Subscribed, not read once: the owner notifies and the shell re-renders for the
  // session it shows. `stateFor` returns the same object while that session is
  // unchanged, which is what the comparison needs.
  const sessionPanelState = useSyncExternalStore(
    owner.subscribe,
    () =>
      selectedSessionId
        ? owner.stateFor(selectedSessionId)
        : initialWorkspacePanelSessionState,
    () =>
      selectedSessionId
        ? owner.stateFor(selectedSessionId)
        : initialWorkspacePanelSessionState,
  );
  const workspacePanel = sessionPanelState.workspacePanel;
  const progressPanelOpen = Boolean(selectedSessionId) && sessionPanelState.progressPanelOpen;
  const dispatchWorkspacePanel = useCallback((command: WorkspacePanelCommand) => {
    if (!selectedSessionId) return;
    owner.dispatch(selectedSessionId, command);
    // A closed tab has no reader: its file slot goes with it, and any read still
    // in flight for it can no longer commit. Other tabs' reads are keyed
    // separately, so this stops nothing else.
    if (command.type === "close-tab") queries.discardFileTab(command.tabId);
  }, [selectedSessionId, queries]);
  const setProgressPanelOpen = (update: boolean | ((open: boolean) => boolean)) => {
    if (!selectedSessionId) return;
    const current = owner.stateFor(selectedSessionId);
    const open = typeof update === "function" ? update(current.progressPanelOpen) : update;
    owner.setProgressPanelOpen(selectedSessionId, open);
  };

  return {
    sessionPanelState,
    workspacePanel,
    progressPanelOpen,
    dispatchWorkspacePanel,
    setProgressPanelOpen,
  };
}
