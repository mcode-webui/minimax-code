// The Agent's browser tools, over this process's browser service.
//
// The Agent's tools call `LocalBrowserAdapter.execute`. Nothing in the WebUI
// implemented that interface until now, so a WebUI-hosted Agent drove a
// *different* browser from the one the panel shows — the exact split ADR 0019
// exists to prevent. This adapter closes the link: one tool call in, one
// service call out, and the service's answer handed back as the tool's answer.
//
// It implements no browser logic of its own. What a command means, whether a
// surface may be touched, which target the run is on and what the provider
// does with the command are the service's answers, and this module passes them
// on with their error codes intact. Flattening them would make "the surface is
// switched off", "nothing is selected" and "that is not an allowed action" one
// indistinguishable failure, and the Agent would retry the wrong thing.
//
// The one decision it makes itself is refusing an action outside the restricted
// command set. The service widens to any DevTools method under the Full CDP
// switch, which serves the panel's explicit `sendBrowserCommand` path; this
// adapter *declares* the restricted set as its capability, so accepting a raw
// DevTools method here would contradict that declaration and silently widen the
// Agent's tools on a host that authorized a different path.
//
// Which surface a call lands on is not a decision it makes at all. The tool
// context carries no surface and the runtime cannot be asked for one, so the
// adapter asks the service which surface the calling run has selected on — the
// state the panel wrote when the person picked a target. A run that has selected
// nothing is refused rather than sent to the isolated Chromium, which is the
// browser this process owns: defaulting to it would put the Agent on a browser
// the person is not looking at, which is the split this adapter exists to close.

import {
  WEBUI_BROWSER_RESTRICTED_COMMANDS,
  type WebuiBrowserSurface,
  type WebuiBrowserTargetId,
} from "../../shared/contracts/browser.js";
import type { WebuiBrowserAdapter } from "../browser-provider.js";
import { isRestrictedBrowserCommand } from "./authorization.js";
import { browserOperationError } from "./errors.js";

/** The provider name the runtime's browser guidance and skills branch on. */
const WEBUI_BROWSER_TOOL_PROVIDER = "webui-browser";

/** The capability declaration's version. Bumped when the declared set changes. */
const WEBUI_BROWSER_TOOL_CAPABILITY_VERSION = 1;

/**
 * The service, as this adapter uses it.
 *
 * Declared structurally rather than imported from the service class: what an
 * adapter needs is the two methods that answer "which browser is this run on"
 * and "run this on the selected page", and a structural declaration is what
 * lets a test drive the adapter without standing up a browser.
 * `WebuiBrowserService` satisfies it as it stands.
 *
 * The run id is part of the question rather than an argument the service could
 * do without: the selection belongs to the run that made it, so a call without
 * one would be asking about a target that may not be this run's.
 */
export interface WebuiBrowserToolCommandSurface {
  /**
   * The surface one run is working on, from that run's own selections.
   *
   * `undefined` when the run has selected nothing anywhere, which is the
   * adapter's cue to refuse rather than to choose a browser.
   */
  selectionSurfaceOf(runId: string): WebuiBrowserSurface | undefined;
  /**
   * Opens a page for a run and makes it the run's selection.
   *
   * The bootstrap: `open_tab` is the one action a run with no selection may
   * perform, because it is the action that would create the selection the
   * gate wants.
   */
  openWebTab(
    runId: string,
    params?: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<{
    readonly accepted: true;
    readonly target: WebuiBrowserTargetId;
    readonly result?: unknown;
  }>;
  sendCommandToSelection(
    surface: WebuiBrowserSurface,
    runId: string,
    command: string,
    params?: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<{
    readonly accepted: true;
    readonly target: WebuiBrowserTargetId;
    readonly result?: unknown;
  }>;
}

/**
 * The tool action, as the runtime's own adapter contract declares it.
 *
 * Read off the contract rather than named from `@mavis/agent-tools`: that
 * package is not this package's dependency, and `WebuiBrowserAdapter` already
 * *is* the runtime's `LocalBrowserAdapter`, reached through the option the
 * runtime host factory takes.
 */
type WebuiBrowserToolAction = Parameters<WebuiBrowserAdapter["execute"]>[1];

export interface CreateWebuiBrowserToolAdapterOptions {
  /**
   * The browser service this adapter acts through.
   *
   * It is the only thing that knows which surface the calling run is on, and it
   * answers from that run's own selections — the panel's selections, which the
   * person made.
   */
  readonly browser: WebuiBrowserToolCommandSurface;
}

/**
 * Builds the Agent's browser-tool adapter over a browser service.
 *
 * The result is what the runtime host takes as its browser provider, so the
 * person and the Agent end up on the one browser session the panel shows.
 */
export function createWebuiBrowserToolAdapter(
  options: CreateWebuiBrowserToolAdapterOptions,
): WebuiBrowserAdapter {
  return {
    /**
     * The declared capability.
     *
     * The action list is the restricted command set itself rather than a copy of
     * it: the gate that enforces the set and the code that declares it then
     * cannot drift apart, and an action the set does not contain is not offered
     * to the model at all.
     *
     * `interactiveTakeover` is true because the person really can take over the
     * page these actions drive — it is the same page the panel is showing, and
     * the panel's input goes to the same selected target.
     */
    getCapabilities: () => ({
      provider: WEBUI_BROWSER_TOOL_PROVIDER,
      version: WEBUI_BROWSER_TOOL_CAPABILITY_VERSION,
      actions: WEBUI_BROWSER_RESTRICTED_COMMANDS,
      interactiveTakeover: true,
    }),
    /**
     * Runs one browser-tool action on the selected target of the surface this
     * run is working on.
     *
     * The surface is the run's own, read back from the service, and the run is
     * the Agent session the tool call belongs to. Two runs driving one surface
     * act on the target each of them selected, never on each other's, and a run
     * that selected on `edge` acts on `edge` rather than on the browser this
     * process happens to own.
     *
     * The provider's own result is returned, not the service's envelope: the
     * runtime's browser tools shape what they get from it — a `screenshot` is
     * only delivered as an image when the result carries the image at the top
     * level — so wrapping it would hide a successful action behind an envelope
     * nobody unwraps.
     *
     * A refused call is not caught. The service's code (`browser_surface_not_authorized`,
     * `browser_target_unknown`, `browser_capability_denied`, …) travels to the
     * Agent as the tool's error code, which is how a run learns whether to ask
     * the person to select a page or to switch something on or to try something
     * else.
     */
    execute: async (ctx, action: WebuiBrowserToolAction, input, signal) => {
      if (!isRestrictedBrowserCommand(action)) {
        throw browserOperationError(
          "browser_capability_denied",
          `The browser action "${action}" is not in the restricted command set.`,
        );
      }
      // The run is the Agent session the tool call belongs to, and it owns the
      // selection: two runs driving one surface act on the target each of them
      // selected, never on each other's.
      const runId = ctx.sessionId;
      if (action === "open_tab") {
        // `open_tab` is the bootstrap, and it is the only exception to the
        // gate below. It is the action that would create the selection the
        // gate wants, so it is the one action a run with no selection may
        // perform — and it moves the run's selection to the page it opened.
        // Every other action of a run with no selection is still refused.
        const { result } = await options.browser.openWebTab(runId, input, signal);
        return result;
      }
      const surface = options.browser.selectionSurfaceOf(runId);
      if (!surface) {
        // There is no surface to act on that the run chose, and no honest
        // default: the isolated Chromium is a browser the person never pointed
        // at. The run has to be given a target first.
        throw browserOperationError(
          "browser_target_unknown",
          "This run has not selected a browser target, so there is no browser to act on.",
        );
      }
      const { result } = await options.browser.sendCommandToSelection(
        surface,
        runId,
        action,
        input,
        signal,
      );
      return result;
    },
  };
}