// The browser authorization gate.
//
// Every browser path — the panel's image stream, the panel's input forwarding,
// the Agent's browser tools, the extension bridge — asks this module before it
// touches a browser. The gate is deliberately in one place: four independent
// switches spread across four call sites drift, and a switch that is checked
// in three of the four places it applies to is a switch that is off in one.
//
// The rules the gate enforces:
//
//   * A surface is usable only when its own switch is on. Full CDP never
//     authorizes a surface; it widens an already-authorized one.
//   * A disabled surface is refused before anything is attempted, so the
//     refusal is distinguishable from a failure.
//   * The Full CDP gate is checked separately from the surface gate, because
//     turning Full CDP off must block full-CDP-only commands without
//     disabling ordinary Browser Use.

import {
  isWebuiBrowserSurfaceAuthorized,
  normalizeWebuiBrowserAuthorization,
  WEBUI_BROWSER_AUTHORIZATION_DEFAULT,
  WEBUI_BROWSER_RESTRICTED_COMMANDS,
  type WebuiBrowserAuthorization,
  type WebuiBrowserError,
  type WebuiBrowserSurface,
} from "../../shared/contracts/browser.js";

/** Which switch a surface's authorization is read from. */
export type WebuiBrowserAuthorizationSwitch =
  | "isolated-chromium"
  | "edge"
  | "chrome"
  | "full-cdp";

/**
 * The switch a surface is gated by.
 *
 * `full-cdp` is not a surface: it is the widening of whatever surface is
 * already authorized. A caller asking about it gets the global switch.
 */
export function browserSwitchForSurface(
  surface: WebuiBrowserAuthorizationSwitch,
): keyof WebuiBrowserAuthorization {
  switch (surface) {
    case "isolated-chromium":
      return "isolatedChromium";
    case "edge":
      return "edge";
    case "chrome":
      return "chrome";
    case "full-cdp":
      return "fullCdp";
    default: {
      const exhaustive: never = surface;
      return exhaustive;
    }
  }
}

/** The authorization a host has when it has said nothing: nothing is allowed. */
export function defaultBrowserAuthorization(): WebuiBrowserAuthorization {
  return { ...WEBUI_BROWSER_AUTHORIZATION_DEFAULT };
}

/**
 * Reads a host's authorization, normalising anything missing to off.
 *
 * A host that answers with a partial record has not authorized the missing
 * parts. Defaulting a missing key to `true` would turn an incomplete answer
 * into a grant.
 *
 * The rule itself is the shared contract's, because the client reads an answer
 * the same way: one rule, one answer, whichever side is looking.
 */
export function normalizeBrowserAuthorization(
  raw: Partial<WebuiBrowserAuthorization> | undefined,
): WebuiBrowserAuthorization {
  return normalizeWebuiBrowserAuthorization(raw);
}

/** The refusal a surface that is not authorized gets. */
export function browserSurfaceNotAuthorizedError(
  surface: WebuiBrowserSurface,
): WebuiBrowserError {
  return {
    code: "browser_surface_not_authorized",
    message: `Browser surface "${surface}" is not authorized.`,
    retryable: false,
  };
}

/** The refusal a full-CDP-only command gets while the Full CDP switch is off. */
export function browserFullCdpNotAuthorizedError(): WebuiBrowserError {
  return {
    code: "browser_capability_denied",
    message: "Full CDP access is not authorized.",
    retryable: false,
  };
}

/**
 * Whether a surface may be used at all.
 *
 * This is the check every browser path makes before it acts. It does not
 * consider Full CDP: a surface can be perfectly usable while the Full CDP
 * switch is off, and a path that asked about Full CDP here would refuse
 * ordinary Browser Use as well.
 */
export function isBrowserSurfaceUsable(
  authorization: WebuiBrowserAuthorization,
  surface: WebuiBrowserSurface,
): boolean {
  return isWebuiBrowserSurfaceAuthorized(authorization, surface);
}

/**
 * Whether a command is one of the restricted browser-tool actions.
 *
 * Distinct from `isBrowserCommandAllowed`, which also answers "yes, when Full
 * CDP is on". The Agent's browser-tool path asks this one: its declared
 * capability is the restricted set, so a raw DevTools method is not something
 * it can carry out even on a host where Full CDP is authorized for the
 * explicit path.
 */
export function isRestrictedBrowserCommand(command: string): boolean {
  return WEBUI_BROWSER_RESTRICTED_COMMANDS.includes(command as never);
}

/**
 * Whether a command may be sent under the restricted set or only under Full
 * CDP.
 *
 * The restricted set is what ordinary Browser Use may do. A command outside it
 * needs the Full CDP switch, and only then — the two are independent, so
 * switching Full CDP on does not need a surface to be authorized as a
 * precondition for the *decision*, and switching a surface on does not grant
 * the full command set.
 */
export function isBrowserCommandAllowed(
  authorization: WebuiBrowserAuthorization,
  command: string,
  restrictedCommands: readonly string[],
): boolean {
  if (restrictedCommands.includes(command)) return true;
  return authorization.fullCdp === true;
}
