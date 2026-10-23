// Browser Use wire contracts.
//
// These are the pinned contracts for the Browser Use programme (ADR 0019). They
// live in `shared/` because both the browser panel and the Agent's browser
// tooling address the *same* browser session, and a contract that existed only
// on one side would let the two drift apart — the failure mode the ADR names
// as "the panel shows one page and the Agent drives another".
//
// Everything here is a wire shape, not an implementation. The runtime, the
// server and the client each hold their own machinery; this module is the
// vocabulary they agree on.
//
// | Declaration | Wire purpose | Producer | Consumers |
// | --- | --- | --- | --- |
// | `WebuiBrowserSurface` | Which browser a target belongs to. | Shared constant. | Runtime authorization; bridge admission; client projection. |
// | `WebuiBrowserAuthorization` | The four independent switches, each defaulting to off. | `config` root `browser`. | Runtime authorization; Settings surface. |
// | `WebuiBrowserTargetId` | A target's identity: surface, browser, tab and generation. | Provider / bridge session. | Runtime target registry; client projection; input forwarding. |
// | `WebuiBrowserTargetGeneration` | The monotonic counter that invalidates stale references. | Provider / bridge session. | Runtime target registry; input forwarding. |
// | `WebuiBrowserTargetState` | One target as the client sees it. | Runtime target registry. | Client browser projection. |
// | `WebuiBrowserTargetList` | The target list for one surface. | Runtime target registry. | Client browser projection. |
// | `WebuiBrowserInputCommand` | A validated pointer / keyboard / text command. | Client browser panel. | Runtime input path; bridge session. |
// | `WebuiBrowserImageFrame` | One frame of a page's live image stream. | Provider / bridge session. | Client browser panel. |
// | `WebuiBrowserErrorCode` | The stable failure codes every browser path reports. | All browser paths. | Client browser projection; Agent tool errors. |
//
// The generation is not decoration. A target that navigated, reloaded or was
// replaced by a new tab is a *different* page even when the browser hands back
// the same tab id, so an element reference recorded before the change would
// point at nothing. Carrying the generation in the target identity makes that
// mismatch detectable instead of silently mis-aimed.

/**
 * The browser a target belongs to.
 *
 * `isolated-chromium` is the browser this process launches and owns. `edge`
 * and `chrome` are the person's own browsers, reached through the extension
 * bridge. The three are separate authorizations: enabling one never implies
 * another.
 */
export const WEBUI_BROWSER_SURFACES = ["isolated-chromium", "edge", "chrome"] as const;

export type WebuiBrowserSurface = (typeof WEBUI_BROWSER_SURFACES)[number];

/** The surfaces that are reached through the extension bridge rather than launched here. */
export const WEBUI_BRIDGE_BROWSER_SURFACES = ["edge", "chrome"] as const;

export type WebuiBridgeBrowserSurface = (typeof WEBUI_BRIDGE_BROWSER_SURFACES)[number];

/**
 * The four independent authorization switches.
 *
 * Each is separate on purpose. "Isolated Chromium" and "Full CDP" are
 * different risks — the first says a browser may be launched, the second says
 * a caller may send *any* DevTools command — and the two external browsers are
 * the person's own machines. A single combined switch would make it impossible
 * to allow one without allowing the rest, which is exactly what the ADR
 * forbids.
 *
 * Every switch is off unless the configuration says otherwise.
 */
export interface WebuiBrowserAuthorization {
  /** The isolated Chromium this process launches and owns. */
  readonly isolatedChromium: boolean;
  /** The person's Microsoft Edge, reached through the extension bridge. */
  readonly edge: boolean;
  /** The person's Google Chrome, reached through the extension bridge. */
  readonly chrome: boolean;
  /** Whether a caller may send arbitrary DevTools commands instead of the restricted set. */
  readonly fullCdp: boolean;
}

/** The authorization a fresh install has: nothing is allowed until it is asked for. */
export const WEBUI_BROWSER_AUTHORIZATION_DEFAULT: WebuiBrowserAuthorization = Object.freeze({
  isolatedChromium: false,
  edge: false,
  chrome: false,
  fullCdp: false,
});

/**
 * The authorization an answer carries, read as four switches.
 *
 * A missing field is off, and only an explicit `true` turns a switch on. That
 * is the same rule on both sides of the wire — the runtime reads a partial
 * configuration this way, and the client reads a partial answer this way — so
 * a host that answers with one switch has authorized that one and nothing
 * else.
 *
 * The rule lives here rather than in either side because a switch that is
 * `undefined` is not "off": it is a switch whose state nobody knows, and a
 * control that renders it without an `aria-checked` of its own says nothing
 * about what it is.
 */
export function normalizeWebuiBrowserAuthorization(
  raw: Partial<WebuiBrowserAuthorization> | undefined,
): WebuiBrowserAuthorization {
  return {
    isolatedChromium: raw?.isolatedChromium === true,
    edge: raw?.edge === true,
    chrome: raw?.chrome === true,
    fullCdp: raw?.fullCdp === true,
  };
}

/**
 * One authorization change.
 *
 * The four switches are written one at a time and every field is optional, so
 * a change that names one switch cannot silently clear the other three. A
 * change that names none is refused by the operation's validator rather than
 * treated as "turn everything off".
 */
export interface WebuiBrowserAuthorizationChange {
  readonly isolatedChromium?: boolean;
  readonly edge?: boolean;
  readonly chrome?: boolean;
  readonly fullCdp?: boolean;
}

/**
 * Whether the surface itself is authorized, independent of the Full CDP gate.
 *
 * The Full CDP switch only ever *widens* what an already-authorized surface may
 * do; it never authorizes a surface on its own.
 */
export function isWebuiBrowserSurfaceAuthorized(
  authorization: WebuiBrowserAuthorization,
  surface: WebuiBrowserSurface,
): boolean {
  switch (surface) {
    case "isolated-chromium":
      return authorization.isolatedChromium;
    case "edge":
      return authorization.edge;
    case "chrome":
      return authorization.chrome;
    default: {
      const exhaustive: never = surface;
      return exhaustive;
    }
  }
}

/**
 * A target's generation.
 *
 * The provider raises it whenever the page behind a target identity is
 * replaced — a navigation, a reload, a tab that was closed and reopened. Every
 * element reference and every pending input is bound to the generation it was
 * recorded against, so a stale one is rejected instead of landing on the new
 * page.
 */
export type WebuiBrowserTargetGeneration = number;

/** The generation a target has before the provider has ever reported it. */
export const WEBUI_BROWSER_TARGET_GENERATION_UNSET = 0;

/**
 * The identity of one browser target.
 *
 * `browserId` separates two instances of the same surface — two Edge windows
 * pairing with the same host, or a relaunched isolated Chromium — so that an
 * input bound to one can never land in the other. `targetId` identifies the tab
 * inside that browser. Together with `generation` they make the three things
 * that can go stale: the browser, the tab, and the page behind the tab.
 */
export interface WebuiBrowserTargetId {
  readonly surface: WebuiBrowserSurface;
  readonly browserId: string;
  readonly targetId: string;
  readonly generation: WebuiBrowserTargetGeneration;
}

/** Whether one target identity is the same page another identity names. */
export function isSameWebuiBrowserTarget(
  left: WebuiBrowserTargetId,
  right: WebuiBrowserTargetId,
): boolean {
  return (
    left.surface === right.surface &&
    left.browserId === right.browserId &&
    left.targetId === right.targetId &&
    left.generation === right.generation
  );
}

/** The state a target can be in. A closed target is kept so a stale reference is explainable. */
export type WebuiBrowserTargetStatus = "open" | "closed";

/** One target as the client sees it. */
export interface WebuiBrowserTargetState {
  readonly id: WebuiBrowserTargetId;
  readonly title: string;
  readonly url: string;
  /** The page's declared favicon URL, when one is available. */
  readonly faviconUrl?: string;
  readonly status: WebuiBrowserTargetStatus;
  /** Whether this target is the one the panel is currently showing. */
  readonly selected: boolean;
}

/** Every target the host knows about for one surface. */
export interface WebuiBrowserTargetList {
  readonly surface: WebuiBrowserSurface;
  readonly targets: readonly WebuiBrowserTargetState[];
}

/**
 * One web tab the runtime publishes.
 *
 * A web tab is a page of the isolated Chromium. The `id` is the runtime's
 * handle for it, and it is the target's id: a page that navigates keeps its
 * target id and gains a generation, so the web tab is still the same web tab.
 *
 * The `target` is the **binding** the client holds. The tab's own id belongs
 * to the client and is assigned when the tab is opened; the runtime's target
 * identity is what the client binds the tab to, and it is the thing that
 * identifies the page uniquely — a target id alone names a page in one
 * browser only.
 */
export interface WebuiBrowserWebTab {
  /** The runtime's id for the web tab. It is the target's id. */
  readonly id: string;
  /** The target the web tab is bound to. The generation moves with the page. */
  readonly target: WebuiBrowserTargetId;
  /** The page's title, as the provider reports it. */
  readonly title: string;
  /** The page's url, as the provider reports it. */
  readonly url: string;
  /** The page's declared favicon URL, when one is available. */
  readonly faviconUrl?: string;
  /** Whether this web tab is the run's selection. */
  readonly selected: boolean;
}

/**
 * The session's web tabs, as a snapshot.
 *
 * A snapshot rather than a delta: the list is small, and a snapshot is
 * idempotent, so a client that reconnects reconciles against it instead of
 * drifting away from the runtime's record of what is open.
 */
export interface WebuiBrowserWebTabSnapshot {
  readonly surface: WebuiBrowserSurface;
  readonly tabs: readonly WebuiBrowserWebTab[];
}

/**
 * The page a request to open one produced.
 *
 * `open_tab` answers with the identity of the page it created rather than with
 * the page's picture, and both callers — the Agent's browser tools and the
 * person's new tab page — get this answer. `accepted` says the request was
 * allowed to try, and the identity is what the caller binds a tab to: the
 * title and the URL arrive later, on the runtime's own snapshot.
 */
export interface WebuiBrowserWebTabOpen {
  readonly accepted: true;
  /** The identity of the page that was created. */
  readonly target: WebuiBrowserTargetId;
  readonly result?: unknown;
}

/**
 * Who opened a web tab, and therefore what the new page does to the run's selection.
 *
 * The two cells are separate (ADR 0022): the run's selection is the runtime's and
 * the Agent writes it, the tab the person is looking at is the client's and the
 * person writes it. Opening a page is the one request that can reach across, so it
 * says which side asked:
 *
 * - `agent` — the run's own `open_tab`. The page becomes the run's selection, and a
 *   second `open_tab` moves it to the second page. The run is writing its own cell.
 * - `person` — the new tab page's url box. The page is recorded as the session's web
 *   tab either way, and becomes the run's selection **only when the run has none at
 *   that moment**. That is the bootstrap, and it is a bootstrap rather than a
 *   co-write: it is decided from the run's selection at the moment the page is
 *   opened, and after it the two cells are independent again.
 */
export type WebuiBrowserTabOpener = "agent" | "person";

/**
 * The key a client reconciles a web tab by.
 *
 * The runtime's id is the target's id, and a target id names a page in one
 * browser only — two surfaces can hold the same one. The binding is the whole
 * identity, so the binding is the key.
 */
/**
 * The answer to a request that closes a web tab.
 *
 * The page is gone, so there is nothing to name: the answer says which page was
 * closed and that the close was accepted.
 */
export interface WebuiBrowserWebTabClose {
  readonly accepted: true;
  readonly targetId: string;
}

export function webuiBrowserWebTabKey(target: WebuiBrowserTargetId): string {
  return `${target.surface}:${target.browserId}:${target.targetId}`;
}

/**
 * A validated input command aimed at one target.
 *
 * The panel does not forward raw DOM events. It converts them into this
 * command, the command is validated before it is sent, and it is bound to the
 * target it was aimed at — so a panel that is showing a stale page cannot
 * deliver input to whatever replaced it.
 */
export type WebuiBrowserInputCommand =
  | {
      readonly kind: "pointer";
      readonly target: WebuiBrowserTargetId;
      /** Omitted means an atomic click for compatibility with existing callers. */
      readonly action?: "press" | "release" | "move" | "scroll";
      readonly x: number;
      readonly y: number;
      readonly button?: "left" | "middle" | "right";
      readonly clickCount?: number;
      readonly deltaX?: number;
      readonly deltaY?: number;
    }
  | {
      readonly kind: "key";
      readonly target: WebuiBrowserTargetId;
      readonly key: string;
      readonly code?: string;
      readonly text?: string;
      readonly modifiers: readonly WebuiBrowserInputModifier[];
    }
  | {
      readonly kind: "text";
      readonly target: WebuiBrowserTargetId;
      readonly text: string;
    };

export type WebuiBrowserInputModifier = "alt" | "ctrl" | "meta" | "shift";

/**
 * The stable failure codes every browser path reports.
 *
 * They are stable strings rather than free-form messages because both the
 * client and the Agent's tools branch on them: "the target moved on" and "the
 * browser is switched off" are different facts, and a caller that cannot tell
 * them apart will retry the wrong thing.
 */
export const WEBUI_BROWSER_ERROR_CODES = [
  /** The surface is not authorized, so nothing was attempted. */
  "browser_surface_not_authorized",
  /** The target identity named by the caller is no longer current. */
  "browser_target_stale",
  /** The target named by the caller does not exist. */
  "browser_target_unknown",
  /** The command did not satisfy the input contract and was not forwarded. */
  "browser_command_invalid",
  /** The provider or bridge failed while carrying out the command. */
  "browser_provider_failed",
  /** The provider or bridge could not be reached. */
  "browser_provider_unavailable",
  /** The operation exceeded its deadline. */
  "browser_operation_timeout",
  /** The pairing credential was rejected or has been revoked. */
  "browser_pairing_rejected",
  /** No OS secure store was available for a credential that must not be stored in a file. */
  "browser_credential_store_unavailable",
  /** The caller asked for a capability that the authorized surface does not offer. */
  "browser_capability_denied",
  /** The caller's request was cancelled. */
  "browser_operation_cancelled",
] as const;

export type WebuiBrowserErrorCode = (typeof WEBUI_BROWSER_ERROR_CODES)[number];

/** The failure shape every browser path reports. */
export interface WebuiBrowserError {
  readonly code: WebuiBrowserErrorCode;
  readonly message: string;
  /** Whether retrying the same command could plausibly succeed. */
  readonly retryable: boolean;
}

/**
 * One frame of a page's live image stream.
 *
 * The frame carries the target it belongs to, including the generation, so a
 * client that receives a frame for a target it is no longer showing can drop it
 * rather than display a page that is not the one the user chose.
 */
/**
 * The size the browser's window should be.
 *
 * The browser is a window, and a window is the size of the place it is shown
 * in. A page drawn into a surface of another shape is scaled down, and the
 * person reads it at half the size. The panel therefore states the size it
 * shows the page at, and the browser takes it.
 *
 * It is a request, not a fact: the page behind the target is the same page
 * whoever looks at it, and the runtime may refuse the size.
 */
export interface WebuiBrowserViewport {
  readonly width: number;
  readonly height: number;
}

export interface WebuiBrowserImageFrame {
  readonly target: WebuiBrowserTargetId;
  /** Base64 image bytes, as the transport encodes them. */
  readonly data: string;
  readonly format: "png" | "jpeg";
  /** Monotonic per-stream counter, so a client can detect a dropped frame. */
  readonly sequence: number;
}

/**
 * The restricted browser-tool command set.
 *
 * These are the semantic actions the Agent's browser tools are allowed to
 * perform. Anything outside this set is a raw DevTools command, and it needs
 * the Full CDP switch.
 *
 * The list is the set the programme inherited from the existing browser-tool
 * contract. It is declared here so the gate that enforces it and the code
 * that implements it cannot drift apart: a command that is implemented but
 * not listed would be refused, and a command that is listed but not
 * implemented would be accepted and then fail.
 */
export const WEBUI_BROWSER_RESTRICTED_COMMANDS = [
  "inspect",
  "query",
  "navigate",
  "open_tab",
  "return_to_previous_tab",
  "back",
  "forward",
  "reload",
  "click",
  "click_and_wait_for_navigation",
  "double_click",
  "drag",
  "fill",
  "type",
  "press_key",
  "check",
  "uncheck",
  "select_option",
  "upload_files",
  "paste",
  "scroll",
  "hover",
  "wait",
  "wait_for",
  "get_dom",
  "screenshot",
  "verify_text",
  "inspect_editable_targets",
] as const;

export type WebuiBrowserRestrictedCommand = (typeof WEBUI_BROWSER_RESTRICTED_COMMANDS)[number];

/**
 * One browser command.
 *
 * `command` is either a restricted browser-tool action (`navigate`, `reload`,
 * …) or a raw DevTools method. The runtime decides which kind is allowed: a
 * raw method needs the Full CDP switch, and the Full CDP switch never
 * authorizes a surface on its own.
 */
export interface WebuiBrowserCommandRequest {
  readonly surface: WebuiBrowserSurface;
  readonly command: string;
  readonly params?: Readonly<Record<string, unknown>>;
  /**
   * The page the command acts on.
   *
   * A web tab's toolbar names the page its tab holds, because a tab is what the
   * person is looking at: it is neither a run's selection nor the panel's own
   * cell, so a command that resolved either would drive a page nobody is
   * watching. A request that names no target keeps the old answer — a run's
   * selection when it names a run, the panel's own cell otherwise — so the
   * Agent's tools are unaffected.
   */
  readonly target?: WebuiBrowserTargetId;
}

/**
 * The capability matrix: what one surface offers, and under which switch.
 *
 * The matrix is a *declaration*, not a probe result. It says what the host
 * intends to offer; the runtime still checks each call against the live
 * authorization, so a matrix that is wrong degrades to a refused call rather
 * than an unearned capability.
 */
export interface WebuiBrowserCapabilityEntry {
  readonly surface: WebuiBrowserSurface;
  /** Whether the surface needs the extension bridge rather than a local provider. */
  readonly bridged: boolean;
  /** Whether the surface can deliver a live image stream. */
  readonly liveImages: boolean;
  /** Whether the surface can accept pointer / keyboard / text input. */
  readonly input: boolean;
  /** Whether the surface can be driven by the Agent's browser tools. */
  readonly agentTools: boolean;
  /** Whether Full CDP widens this surface's command set. */
  readonly fullCdpApplies: boolean;
}
