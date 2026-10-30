// The standalone Mini App page: one Mini App, and nothing else.
//
// ADR 0020's second presentation. A browser tab opened through
// `/miniapp?plugin=&session=` runs this same client, and the shell mounts this
// component instead of the workspace: what a person sees is the Mini App view
// alone, with no rail, no conversation and no panel.
//
// Three properties are decisions:
//
//   * **It holds the lease.** Mounting declares the presentation and unmounting
//     releases it, and the service ties the record to the connection this opens —
//     so closing the tab is what ends the presentation, which is why there is no
//     control that would close it (closing the tab is the control).
//   * **An ended session still shows the app.** The Mini App is plugin-scoped, so
//     a page outlives the session its link named; the lease's first frame reports
//     that, and this renders the notice beside the page rather than instead of it.
//   * **No way back inline.** Returning to the panel is closing this tab, so this
//     surface offers no such control — the inline view is where a person goes to
//     switch *to* this presentation, never from it.

import { useEffect, type ReactElement } from "react";

import {
  useWebuiMiniAppWorkflows,
  useWebuiMiniAppWorkflowsState,
} from "../bindings/use-miniapp-workflows.js";
import { MiniAppView } from "./MiniAppView.public.js";
import { FeedbackError } from "../../../ui/feedback.js";

export interface MiniAppStandaloneProps {
  readonly pluginId: string;
  readonly sessionId: string;
}

export function MiniAppStandalone({
  pluginId,
  sessionId,
}: MiniAppStandaloneProps): ReactElement {
  const workflows = useWebuiMiniAppWorkflows();
  const state = useWebuiMiniAppWorkflowsState();

  /**
   * Take the lease for this document, and give it back when the page goes away.
   *
   * Re-subscribing when the ids change is the reload case: a new deep link in the
   * same context replaces the old presentation rather than holding both.
   */
  useEffect(() => {
    if (!workflows) return;
    return workflows.claimStandalone({ pluginId, sessionId });
  }, [pluginId, sessionId, workflows]);

  const standalone = state.standalone;
  const sessionEnded =
    standalone !== undefined &&
    standalone.pluginId === pluginId &&
    standalone.session === "ended";
  const sessionUnresolved =
    standalone !== undefined &&
    standalone.pluginId === pluginId &&
    standalone.session === "unresolved";

  return (
    <div
      className="webui-miniapp-standalone"
      data-testid="miniapp-standalone"
      data-plugin-id={pluginId}
      data-session-id={sessionId}
    >
      {sessionEnded ? (
        <p
          className="webui-miniapp-standalone-notice"
          role="status"
          data-testid="miniapp-standalone-session-ended"
        >
          该会话已结束，Mini App 仍在运行。
        </p>
      ) : null}
      {sessionUnresolved ? (
        <p className="webui-miniapp-standalone-notice" role="status" data-testid="miniapp-standalone-session-lookup-unresolved">
          无法确认会话状态，Mini App 仍在运行。
        </p>
      ) : null}
      {state.standaloneFailure !== undefined ? (
        <FeedbackError message=<>无法确认会话状态：{state.standaloneFailure}</> className="webui-miniapp-standalone-notice" testId="miniapp-standalone-session-unresolved" />
      ) : null}
      <MiniAppView pluginId={pluginId} sessionId={sessionId} surface="standalone" />
    </div>
  );
}
