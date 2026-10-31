// Browser capability port.
//
// The browser business is the one that owns target state, authorization and
// connection projections (ADR 0019, "Business and source layout decisions").
// Settings and the workspace panel consume Browser Use through this port rather
// than through their own copies of the vocabulary, because a second copy of the
// authorization switches is a second answer to "is this browser allowed", and the
// failure the ADR names — the panel shows one page while the Agent drives
// another — starts as exactly that kind of disagreement.
//
// Every method is optional, like every other port in this package: `undefined`
// means "this host does not wire the operation", which is a state the UI has to
// be able to say out loud rather than a failure to discover by calling.
//
// The operation-name constants below are declared here rather than imported from
// `shared/operation-names.ts` because this port lands before the shared table
// does; they carry the same strings the server will bind, and reconciling the
// two spellings is a one-line move once the shared table has the family. What
// matters now is that the strings are named once and are not repeated as
// literals anywhere else in the feature.

import type {
  WebuiBrowserAuthorization,
  WebuiBrowserAuthorizationChange,
  WebuiBrowserCapabilityEntry,
  WebuiBrowserCommandRequest,
  WebuiBrowserImageFrame,
  WebuiBrowserInputCommand,
  WebuiBrowserSurface,
  WebuiBrowserTargetId,
  WebuiBrowserViewport,
  WebuiBrowserTargetList,
  WebuiBrowserTargetState,
  WebuiBrowserWebTabClose,
  WebuiBrowserWebTabOpen,
  WebuiBrowserWebTabSnapshot,
  WebuiBridgeBrowserSurface,
} from "../../../../shared/contracts/browser.js";

// The operation names come from the shared table rather than being declared
// here. A second copy of a wire name is a second answer to "what is this
// operation called", and the browser family is exactly the place where the
// server and the client must not disagree: the panel addresses the same
// session the Agent's tools drive.
import {
  GET_BROWSER_AUTHORIZATION_OPERATION_NAME,
  SET_BROWSER_AUTHORIZATION_OPERATION_NAME,
  LIST_BROWSER_TARGETS_OPERATION_NAME,
  SELECT_BROWSER_TARGET_OPERATION_NAME,
  SEND_BROWSER_INPUT_OPERATION_NAME,
  SEND_BROWSER_COMMAND_OPERATION_NAME,
  WATCH_BROWSER_FRAMES_OPERATION_NAME,
  LIST_BROWSER_CAPABILITIES_OPERATION_NAME,
  GET_BROWSER_INSTALLATION_KEY_OPERATION_NAME,
} from "../../../../shared/operation-names.js";

export {
  GET_BROWSER_AUTHORIZATION_OPERATION_NAME,
  SET_BROWSER_AUTHORIZATION_OPERATION_NAME,
  LIST_BROWSER_TARGETS_OPERATION_NAME,
  SELECT_BROWSER_TARGET_OPERATION_NAME,
  SEND_BROWSER_INPUT_OPERATION_NAME,
  SEND_BROWSER_COMMAND_OPERATION_NAME,
  WATCH_BROWSER_FRAMES_OPERATION_NAME,
  LIST_BROWSER_CAPABILITIES_OPERATION_NAME,
  GET_BROWSER_INSTALLATION_KEY_OPERATION_NAME,
};

/** Every browser operation name, as one closed set. */
export const WEBUI_BROWSER_OPERATION_NAMES = Object.freeze([
  GET_BROWSER_AUTHORIZATION_OPERATION_NAME,
  SET_BROWSER_AUTHORIZATION_OPERATION_NAME,
  LIST_BROWSER_TARGETS_OPERATION_NAME,
  SELECT_BROWSER_TARGET_OPERATION_NAME,
  SEND_BROWSER_INPUT_OPERATION_NAME,
  SEND_BROWSER_COMMAND_OPERATION_NAME,
  WATCH_BROWSER_FRAMES_OPERATION_NAME,
  LIST_BROWSER_CAPABILITIES_OPERATION_NAME,
  GET_BROWSER_INSTALLATION_KEY_OPERATION_NAME,
] as const);

/**
 * Which switch a UI toggle moved.
 *
 * The three surfaces are `WebuiBrowserSurface` verbatim; `full-cdp` is not a
 * surface because it is not a browser — it widens the command set of whatever
 * surface is already authorized. Carrying it in the same union is deliberate: the
 * UI has one row per switch and one row's worth of meaning, and Full CDP is one
 * of those rows.
 *
 * This is the *toggle*, not the wire request. The write that travels is the
 * shared `WebuiBrowserAuthorizationChange`, and `webuiBrowserAuthorizationChange`
 * in `../application/browser-commands.ts` is the one mapping between them — so
 * the shape the wire accepts is named in `shared/` and nowhere here.
 */
export type WebuiBrowserAuthorizationSwitch = WebuiBrowserSurface | "full-cdp";

export const WEBUI_BROWSER_AUTHORIZATION_SWITCHES = Object.freeze([
  "isolated-chromium",
  "edge",
  "chrome",
  "full-cdp",
] as const satisfies readonly WebuiBrowserAuthorizationSwitch[]);

/** One switch moving, as a UI row reports it. */
export interface WebuiBrowserAuthorizationToggle {
  readonly surface: WebuiBrowserAuthorizationSwitch;
  readonly enabled: boolean;
}

/** What `listBrowserCapabilities` reports: the matrix, not a probe result. */
export interface WebuiBrowserCapabilityList {
  readonly entries: readonly WebuiBrowserCapabilityEntry[];
}

/**
 * What the installation-key read returns.
 *
 * `present: false` is its own case rather than an empty `key`, because the
 * two mean different things to the person: one is "switch this surface on and
 * come back", the other would be a value to paste that could never work.
 */
export type WebuiBrowserInstallationKeyResult =
  | {
      readonly present: false;
      readonly surface: WebuiBridgeBrowserSurface;
      readonly reason: "not_provisioned";
    }
  | {
      readonly present: true;
      readonly surface: WebuiBridgeBrowserSurface;
      readonly keyId: string;
      readonly key: string;
      readonly fingerprint: string;
    };

/** What `sendBrowserInput` answers. */
export interface WebuiBrowserInputReceipt {
  readonly accepted: boolean;
}

/**
 * Which run the panel is acting for.
 *
 * The selection belongs to a run (ADR 0019), so every request that reads or
 * writes one says which run: the panel sends the active run's id, and sends
 * none when no run is active — which the service reads as the panel's own
 * selection rather than as another run's.
 */
export interface WebuiBrowserRunScope {
  readonly runId?: string;
}

export interface BrowserPort {
  /** The four switches as they stand. Absent means "never read". */
  readonly getBrowserAuthorization?: () => Promise<WebuiBrowserAuthorization>;
  /**
   * Writes the switches named by `change` and returns the whole set afterwards.
   *
   * The request is the shared `WebuiBrowserAuthorizationChange`, whose fields are
   * all optional, and that optionality is what carries the ADR's rule: naming one
   * switch cannot clear the other three. A change that names none is refused by
   * the operation's validator rather than read as "turn everything off".
   */
  readonly setBrowserAuthorization?: (
    change: WebuiBrowserAuthorizationChange,
  ) => Promise<WebuiBrowserAuthorization>;
  /**
   * Every target of one surface, with the named run's selection marked.
   *
   * The flag is the run's own: it is how the panel learns which target the
   * active run is driving without the run having to announce it.
   */
  readonly listBrowserTargets?: (
    request: WebuiBrowserRunScope & { readonly surface: WebuiBrowserSurface },
  ) => Promise<WebuiBrowserTargetList>;
  /** Moves one run's selection to a target, bound to its generation. */
  readonly selectBrowserTarget?: (
    request: WebuiBrowserRunScope & { readonly target: WebuiBrowserTargetId },
  ) => Promise<WebuiBrowserTargetState>;
  /**
   * Delivers one already-validated command.
   *
   * The command arrives validated rather than as a DOM event: the panel that
   * converts a pointer press into this shape is the only place that knows what
   * the user aimed at, and a host that accepted raw input would have to guess.
   *
   * The run is a request field rather than part of the command: it says whose
   * input this is, and the command itself keeps exactly the shape the runtime
   * validates.
   */
  readonly sendBrowserInput?: (
    request: WebuiBrowserRunScope & { readonly command: WebuiBrowserInputCommand },
  ) => Promise<WebuiBrowserInputReceipt>;
  /**
   * Runs one browser command.
   *
   * The runtime decides whether the command is allowed — a restricted
   * browser-tool action, or a raw DevTools command under the Full CDP switch.
   */
  readonly sendBrowserCommand?: (
    request: WebuiBrowserCommandRequest,
  ) => Promise<{ readonly accepted: true; readonly result?: unknown }>;

  /**
   * The live image stream for one **target**.
   *
   * The stream is keyed by the target rather than by the run: the client asks
   * for the page it is showing, so two tabs get their own pictures and the
   * person and the Agent can work on different pages at the same time.
   *
   * Returns the disposer, matching `TerminalPort.watchTerminal`, because the
   * subscription outlives the render that opened it and something has to close
   * it when the panel goes away.
   */
  readonly watchBrowserFrames?: (
    request: {
      readonly surface: WebuiBrowserSurface;
      readonly target: WebuiBrowserTargetId;
      /**
       * The size the panel shows the page at, so the browser's window can take
       * it. Without it the page is scaled into the panel, and the person reads
       * it at half the size.
       */
      readonly viewport?: WebuiBrowserViewport;
    },
    onFrame: (frame: WebuiBrowserImageFrame) => void,
  ) => () => void;
  /**
   * The session's web tabs, as a snapshot, on a stream.
   *
   * The runtime owns the record of what the session has open, and this is how
   * the client learns it: the strip renders what arrives here rather than
   * keeping a copy of its own, because two copies of "what is open" disagree
   * exactly when a tab is closed.
   *
   * Returns the disposer, like `watchBrowserFrames`: the subscription outlives
   * the render that opened it.
   */
  readonly watchBrowserWebTabs?: (
    request: WebuiBrowserRunScope & { readonly surface: WebuiBrowserSurface },
    onSnapshot: (snapshot: WebuiBrowserWebTabSnapshot) => void,
  ) => () => void;
  /**
   * Opens a page and answers with the page's identity.
   *
   * The person's half of the tab model: the new tab page's URL box calls this,
   * and the answer is what the tab binds to. It is the same `open_tab` the
   * Agent's tools perform, so a page typed by hand and a page opened by the
   * Agent go through the same surface switch and the same refusals — the panel
   * does not get a browser of its own by typing into its own launcher.
   *
   * `runId` is sent when the workspace knows its session, and that is what lets the
   * runtime apply the one bootstrap: the page joins the run's selection when the run
   * has none at that moment, and a run already working on a page keeps it. The
   * launcher does not decide that — it cannot see the run's selection, and deciding
   * it on the client would make the person a standing writer of the Agent's cell.
   * Without a `runId` the page is recorded in the panel's own cell, which is the
   * whole answer when there is no run behind the workspace at all.
   */
  readonly openBrowserWebTab?: (
    request: WebuiBrowserRunScope & { readonly url: string },
  ) => Promise<WebuiBrowserWebTabOpen>;
  /**
   * Closes the page a web tab is bound to.
   *
   * The tab names the target it holds, so the runtime closes the page that
   * tab holds. The tab leaves the strip either way — a tab that is still
   * published after it was closed would be a tab the strip cannot get rid of.
   */
  readonly closeBrowserWebTab?: (
    request: { readonly target: WebuiBrowserTargetId },
  ) => Promise<WebuiBrowserWebTabClose>;
  readonly listBrowserCapabilities?: () => Promise<WebuiBrowserCapabilityList>;
  /**
   * Reads one extension-reached surface's installation key so the person can
   * paste it into the extension's options page.
   *
   * Optional because the bridge is optional: a host without one leaves this
   * undefined, and the surface shows the key panel as unavailable rather than
   * inventing a key.
   */
  readonly getBrowserInstallationKey?: (request: {
    readonly surface: WebuiBridgeBrowserSurface;
  }) => Promise<WebuiBrowserInstallationKeyResult>;
}
