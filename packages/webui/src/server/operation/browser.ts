// The browser operations.
//
// Ten operations: the ones that answer a question, the one that changes the
// authorization, the ones that forward an input and a command, and the two
// that stream — the live images, and the web tabs the session has open.
//
// The validators here are deliberately thin. The *shape* of a request is the
// wire's business and belongs in this layer; whether an input command is
// meaningful — a finite coordinate, a known button, a target that still
// exists — is the runtime's business and belongs in `runtime/browser/input.ts`.
// Splitting it that way keeps one set of rules for every caller of the
// runtime, including the Agent's browser tools, which do not come through
// this wire at all.

import { WebuiErrorCode } from "../../shared/envelope.js";
import {
  GET_BROWSER_AUTHORIZATION_OPERATION_NAME,
  GET_BROWSER_INSTALLATION_KEY_OPERATION_NAME,
  LIST_BROWSER_CAPABILITIES_OPERATION_NAME,
  LIST_BROWSER_TARGETS_OPERATION_NAME,
  CLOSE_BROWSER_WEB_TAB_OPERATION_NAME,
  OPEN_BROWSER_WEB_TAB_OPERATION_NAME,
  SELECT_BROWSER_TARGET_OPERATION_NAME,
  SEND_BROWSER_INPUT_OPERATION_NAME,
  SEND_BROWSER_COMMAND_OPERATION_NAME,
  SET_BROWSER_AUTHORIZATION_OPERATION_NAME,
  WATCH_BROWSER_FRAMES_OPERATION_NAME,
  WATCH_BROWSER_WEB_TABS_OPERATION_NAME,
} from "../../shared/operation-names.js";
import {
  WEBUI_BROWSER_SURFACES,
  WEBUI_BRIDGE_BROWSER_SURFACES,
  type WebuiBrowserInputCommand,
  type WebuiBrowserSurface,
  type WebuiBrowserTargetId,
  type WebuiBrowserViewport,
  type WebuiBridgeBrowserSurface,
} from "../../shared/contracts/browser.js";
import type { WebuiOperation, WebuiOperationValidation } from "./operation-contract.js";
import { invalidBody, requireRecord } from "./operation-contract.js";

export const getBrowserAuthorizationOperation: WebuiOperation<Record<string, never>> = {
  name: GET_BROWSER_AUTHORIZATION_OPERATION_NAME,
  validate: (body) => validateEmptyBody(GET_BROWSER_AUTHORIZATION_OPERATION_NAME, body),
};

export const listBrowserCapabilitiesOperation: WebuiOperation<Record<string, never>> = {
  name: LIST_BROWSER_CAPABILITIES_OPERATION_NAME,
  validate: (body) => validateEmptyBody(LIST_BROWSER_CAPABILITIES_OPERATION_NAME, body),
};

/**
 * The installation-key read.
 *
 * Validated to name exactly one of the two extension-reachable surfaces. A
 * request for `isolatedChromium` is refused rather than answered with "no key":
 * there is no extension on that surface, so there is nothing to paste, and
 * returning a shape the caller would misread as "not provisioned yet" would
 * send the person to a page that does not exist.
 */
export const getBrowserInstallationKeyOperation: WebuiOperation<Record<string, unknown>> = {
  name: GET_BROWSER_INSTALLATION_KEY_OPERATION_NAME,
  validate: (body) => validateInstallationKeySurface(
    GET_BROWSER_INSTALLATION_KEY_OPERATION_NAME,
    body,
  ),
};

export const setBrowserAuthorizationOperation: WebuiOperation<Record<string, unknown>> = {
  name: SET_BROWSER_AUTHORIZATION_OPERATION_NAME,
  validate: (body) => validateAuthorizationChange(SET_BROWSER_AUTHORIZATION_OPERATION_NAME, body),
};

export const listBrowserTargetsOperation: WebuiOperation<Record<string, unknown>> = {
  name: LIST_BROWSER_TARGETS_OPERATION_NAME,
  validate: (body) => validateSurface(LIST_BROWSER_TARGETS_OPERATION_NAME, body),
};

export const selectBrowserTargetOperation: WebuiOperation<Record<string, unknown>> = {
  name: SELECT_BROWSER_TARGET_OPERATION_NAME,
  validate: (body) => validateTarget(SELECT_BROWSER_TARGET_OPERATION_NAME, body),
};

export const sendBrowserInputOperation: WebuiOperation<Record<string, unknown>> = {
  name: SEND_BROWSER_INPUT_OPERATION_NAME,
  validate: (body) => validateInputCommand(SEND_BROWSER_INPUT_OPERATION_NAME, body),
};

/**
 * The browser command operation.
 *
 * The validator checks only that the request *names* a surface, a command, and
 * — when it names one — the page it acts on. Whether the command is allowed — a
 * restricted action, or a raw DevTools method under the Full CDP switch — is the
 * runtime's decision, because only the runtime knows the live authorization.
 */
export const sendBrowserCommandOperation: WebuiOperation<Record<string, unknown>> = {
  name: SEND_BROWSER_COMMAND_OPERATION_NAME,
  validate: (body) => validateCommand(SEND_BROWSER_COMMAND_OPERATION_NAME, body),
};

export const watchBrowserFramesOperation: WebuiOperation<Record<string, unknown>> = {
  name: WATCH_BROWSER_FRAMES_OPERATION_NAME,
  validate: (body) => validateFrameStream(WATCH_BROWSER_FRAMES_OPERATION_NAME, body),
};

/**
 * The web-tab snapshot stream.
 *
 * The request names a surface and, optionally, the run whose tabs it wants.
 * The snapshot itself is the runtime's record of the session's web tabs, so
 * there is nothing for the client to ask for beyond which session it is
 * asking about.
 */
export const watchBrowserWebTabsOperation: WebuiOperation<Record<string, unknown>> = {
  name: WATCH_BROWSER_WEB_TABS_OPERATION_NAME,
  validate: (body) => validateSurface(WATCH_BROWSER_WEB_TABS_OPERATION_NAME, body),
};

/**
 * The person's way of opening a page.
 *
 * The request names a url, and a run when there is one. It names no surface:
 * which surface the page belongs to is the runtime's answer, exactly as it is
 * for the Agent's `open_tab`, so the two paths cannot disagree about where a
 * page is opened. Whether the page may be opened at all — the surface's switch,
 * and the provider behind it — is the runtime's decision and keeps its own
 * refusal codes.
 */
export const openBrowserWebTabOperation: WebuiOperation<Record<string, unknown>> = {
  name: OPEN_BROWSER_WEB_TAB_OPERATION_NAME,
  validate: (body) => validateWebTabUrl(OPEN_BROWSER_WEB_TAB_OPERATION_NAME, body),
};

/**
 * The request that closes a web tab.
 *
 * The request names the target the tab is bound to, not a session: the tab
 * knows the page it holds, and the runtime closes the page that tab holds.
 */
export const closeBrowserWebTabOperation: WebuiOperation<Record<string, unknown>> = {
  name: CLOSE_BROWSER_WEB_TAB_OPERATION_NAME,
  validate: (body) => validateWebTabTarget(CLOSE_BROWSER_WEB_TAB_OPERATION_NAME, body),
};

const AUTHORIZATION_SWITCHES = [
  "isolatedChromium",
  "edge",
  "chrome",
  "fullCdp",
] as const;

function validateEmptyBody(
  operation: string,
  body: unknown,
): WebuiOperationValidation<Record<string, never>> {
  const result = requireRecord(operation, body);
  if (!result.ok) return result;
  return Object.keys(result.body).length === 0
    ? { ok: true, body: {} as Record<string, never> }
    : invalidBody(`${operation} body must be an empty object`);
}

/**
 * Validates an authorization change.
 *
 * A change must name at least one switch and may only name known ones. An
 * empty change would otherwise be a no-op that reported success, which reads
 * to the surface as "it is on" when nothing was written.
 */
function validateAuthorizationChange(
  operation: string,
  body: unknown,
): WebuiOperationValidation<Record<string, unknown>> {
  const result = requireRecord(operation, body);
  if (!result.ok) return result;
  const entries = Object.entries(result.body);
  if (entries.length === 0) {
    return invalidBody(`${operation} body must name at least one switch`);
  }
  for (const [key, value] of entries) {
    if (!AUTHORIZATION_SWITCHES.includes(key as (typeof AUTHORIZATION_SWITCHES)[number])) {
      return invalidBody(`${operation} body names an unknown switch "${key}"`);
    }
    if (typeof value !== "boolean") {
      return invalidBody(`${operation} body requires a boolean for "${key}"`);
    }
  }
  return { ok: true, body: result.body };
}

function validateSurface(
  operation: string,
  body: unknown,
): WebuiOperationValidation<Record<string, unknown>> {
  const result = requireRecord(operation, body);
  if (!result.ok) return result;
  const surface = result.body.surface;
  if (
    typeof surface !== "string" ||
    !WEBUI_BROWSER_SURFACES.includes(surface as WebuiBrowserSurface)
  ) {
    return invalidBody(`${operation} body requires a known browser surface`);
  }
  return validateRunId(operation, result.body);
}

/**
 * Validates an installation-key read.
 *
 * Only the two extension-reachable surfaces are accepted. `isolatedChromium`
 * is refused rather than answered with "not provisioned": there is no
 * extension on that surface, so there is nothing to paste, and a "no key yet"
 * answer would send the person to an options page that can never pair.
 */
function validateInstallationKeySurface(
  operation: string,
  body: unknown,
): WebuiOperationValidation<Record<string, unknown>> {
  const result = requireRecord(operation, body);
  if (!result.ok) return result;
  const surface = result.body.surface;
  if (
    typeof surface !== "string" ||
    !WEBUI_BRIDGE_BROWSER_SURFACES.includes(surface as WebuiBridgeBrowserSurface)
  ) {
    return invalidBody(`${operation} body requires a surface reached through the extension bridge`);
  }
  return { ok: true, body: result.body };
}

/**
 * Accepts an optional `runId` on a body that already passed its own rules.
 *
 * The wire frame carries no session id, so the client says which run it is
 * acting for in the body. It is optional because the panel may be showing a
 * browser with no run active, and it is checked when present because the
 * selection is keyed by it: a `runId` that is not a non-empty string would key
 * the service's map by something that is not a run.
 */
function validateRunId(
  operation: string,
  body: Record<string, unknown>,
): WebuiOperationValidation<Record<string, unknown>> {
  const runId = body.runId;
  if (runId !== undefined && (typeof runId !== "string" || runId.length === 0)) {
    return invalidBody(`${operation} body requires a non-empty runId`);
  }
  return { ok: true, body };
}

function validateTarget(
  operation: string,
  body: unknown,
): WebuiOperationValidation<Record<string, unknown>> {
  const result = requireRecord(operation, body);
  if (!result.ok) return result;
  const viewport = result.body.viewport;
  if (viewport !== undefined) {
    if (
      !isRecord(viewport) ||
      typeof viewport.width !== "number" ||
      typeof viewport.height !== "number" ||
      !Number.isFinite(viewport.width) ||
      !Number.isFinite(viewport.height) ||
      viewport.width <= 0 ||
      viewport.height <= 0
    ) {
      return invalidBody(`${operation} body requires a viewport of a width and a height`);
    }
  }
  const target = result.body.target;
  if (!isRecord(target)) {
    return invalidBody(`${operation} body requires a target`);
  }
  if (!isCompleteTargetIdentity(target)) {
    return invalidBody(`${operation} body requires a complete target identity`);
  }
  return validateRunId(operation, result.body);
}

/**
 * Validates a frame-stream request.
 *
 * The request names the **target** the client is showing, not a run: the
 * stream is per target, so two tabs get their own pictures and the person and
 * the Agent can work on different pages at the same time.
 *
 * A request that still carries a run id is refused with an explicit error
 * rather than being answered with the run's selection. A client asking for
 * the old shape would otherwise be shown a page it did not ask for, and a
 * stream that silently answers with the wrong page is worse than one that
 * says the request is out of date.
 */
function validateFrameStream(
  operation: string,
  body: unknown,
): WebuiOperationValidation<Record<string, unknown>> {
  const result = requireRecord(operation, body);
  if (!result.ok) return result;
  if (result.body.runId !== undefined) {
    return invalidBody(
      `${operation} is keyed by a target, not by a run; send the target the client is showing`,
    );
  }
  const surface = result.body.surface;
  if (
    typeof surface !== "string" ||
    !WEBUI_BROWSER_SURFACES.includes(surface as WebuiBrowserSurface)
  ) {
    return invalidBody(`${operation} body requires a known browser surface`);
  }
  const viewport = result.body.viewport;
  if (viewport !== undefined) {
    if (
      !isRecord(viewport) ||
      typeof viewport.width !== "number" ||
      typeof viewport.height !== "number" ||
      !Number.isFinite(viewport.width) ||
      !Number.isFinite(viewport.height) ||
      viewport.width <= 0 ||
      viewport.height <= 0
    ) {
      return invalidBody(`${operation} body requires a viewport of a width and a height`);
    }
  }
  const target = result.body.target;
  if (!isRecord(target)) {
    return invalidBody(`${operation} body requires a target`);
  }
  if (!isCompleteTargetIdentity(target)) {
    return invalidBody(`${operation} body requires a complete target identity`);
  }
  return { ok: true, body: result.body };
}

/** Whether a body carries a target identity with all four of its fields. */
function isCompleteTargetIdentity(target: Record<string, unknown>): boolean {
  return (
    typeof target.surface === "string" &&
    WEBUI_BROWSER_SURFACES.includes(target.surface as WebuiBrowserSurface) &&
    typeof target.browserId === "string" &&
    target.browserId.length > 0 &&
    typeof target.targetId === "string" &&
    target.targetId.length > 0 &&
    typeof target.generation === "number" &&
    Number.isInteger(target.generation)
  );
}
/**
 * Validates the *envelope* of an input command.
 *
 * The command's own rules — finite coordinates, a known button, a non-empty
 * text payload — are enforced by the runtime, once, for every caller.
 */
function validateInputCommand(
  operation: string,
  body: unknown,
): WebuiOperationValidation<Record<string, unknown>> {
  const result = requireRecord(operation, body);
  if (!result.ok) return result;
  const kind = result.body.kind;
  if (kind !== "pointer" && kind !== "key" && kind !== "text") {
    return invalidBody(`${operation} body requires a pointer, key or text command`);
  }
  if (!isRecord(result.body.target)) {
    return invalidBody(`${operation} body requires a target`);
  }
  return validateRunId(operation, result.body);
}

/**
 * Validates the envelope of a browser command.
 *
 * A command with an empty name is malformed and is refused here rather than
 * being forwarded for the runtime to reject.
 *
 * A command may also name the **target** it acts on. That is what a web tab's
 * toolbar sends: the tab holds exactly one page, and the person pressing back
 * means the page they are looking at, not whichever page the surface currently
 * has selected. An absent target is still the selection, so every existing
 * caller keeps its meaning.
 */
function validateCommand(
  operation: string,
  body: unknown,
): WebuiOperationValidation<Record<string, unknown>> {
  const result = requireRecord(operation, body);
  if (!result.ok) return result;
  const surface = result.body.surface;
  if (
    typeof surface !== "string" ||
    !WEBUI_BROWSER_SURFACES.includes(surface as WebuiBrowserSurface)
  ) {
    return invalidBody(`${operation} body requires a known browser surface`);
  }
  const command = result.body.command;
  if (typeof command !== "string" || command.trim().length === 0) {
    return invalidBody(`${operation} body requires a command`);
  }
  const params = result.body.params;
  if (params !== undefined && !isRecord(params)) {
    return invalidBody(`${operation} body requires params to be an object`);
  }
  const target = result.body.target;
  if (target !== undefined && (!isRecord(target) || !isCompleteTargetIdentity(target))) {
    return invalidBody(`${operation} body requires a complete target identity`);
  }
  const runId = result.body.runId;
  if (runId !== undefined && (typeof runId !== "string" || runId.length === 0)) {
    return invalidBody(`${operation} body requires a runId to be a non-empty string`);
  }
  return { ok: true, body: result.body };
}

/**
 * Validates a request to open a page.
 *
 * A page needs a url, and an empty one would open a blank page while answering
 * that the request was honoured — so an empty url is malformed rather than a
 * default. Whether the url is reachable is not this layer's business.
 */
function validateWebTabUrl(
  operation: string,
  body: unknown,
): WebuiOperationValidation<Record<string, unknown>> {
  const result = requireRecord(operation, body);
  if (!result.ok) return result;
  const url = result.body.url;
  if (typeof url !== "string" || url.trim().length === 0) {
    return invalidBody(`${operation} body requires a url`);
  }
  return validateRunId(operation, result.body);
}

/**
 * The request that closes a web tab.
 *
 * The request names the target the tab is bound to. The generation is not
 * required to be current: a tab whose page was replaced is still a tab the
 * person can close, and the page it holds is the one the close reaches.
 */
function validateWebTabTarget(
  operation: string,
  body: unknown,
): WebuiOperationValidation<Record<string, unknown>> {
  const result = requireRecord(operation, body);
  if (!result.ok) return result;
  const viewport = result.body.viewport;
  if (viewport !== undefined) {
    if (
      !isRecord(viewport) ||
      typeof viewport.width !== "number" ||
      typeof viewport.height !== "number" ||
      !Number.isFinite(viewport.width) ||
      !Number.isFinite(viewport.height) ||
      viewport.width <= 0 ||
      viewport.height <= 0
    ) {
      return invalidBody(`${operation} body requires a viewport of a width and a height`);
    }
  }
  const target = result.body.target;
  if (!isRecord(target)) {
    return invalidBody(`${operation} body requires a target`);
  }
  if (
    typeof target.surface !== "string" ||
    !WEBUI_BROWSER_SURFACES.includes(target.surface as WebuiBrowserSurface) ||
    typeof target.browserId !== "string" ||
    target.browserId.length === 0 ||
    typeof target.targetId !== "string" ||
    target.targetId.length === 0 ||
    typeof target.generation !== "number" ||
    !Number.isInteger(target.generation)
  ) {
    return invalidBody(`${operation} body requires a complete target identity`);
  }
  return { ok: true, body: result.body };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The input command a validated body carries, as the runtime expects it. */
export function readBrowserInputCommand(
  body: Record<string, unknown>,
): WebuiBrowserInputCommand {
  // `runId` is the envelope's field, not the command's: leaving it on would
  // smuggle a wire concern into the runtime's own input contract, where the
  // provider and the validator would both have to know about it.
  const { runId: _runId, ...command } = body;
  return command as unknown as WebuiBrowserInputCommand;
}

/**
 * The run a validated body acts for, or `undefined` when the panel has no run
 * active.
 *
 * Absent is a real answer rather than a missing argument: the service reads it
 * as the no-run selection, which is the panel's own.
 */
export function readBrowserRunId(body: Record<string, unknown>): string | undefined {
  const runId = body.runId;
  return typeof runId === "string" && runId.length > 0 ? runId : undefined;
}

/** The target a validated body carries, as the runtime expects it. */
export function readBrowserTarget(body: Record<string, unknown>): WebuiBrowserTargetId {
  return body.target as unknown as WebuiBrowserTargetId;
}

/**
 * The size the panel shows the page at, as the runtime expects it.
 *
 * It is optional: a body that states no size leaves the browser's window as
 * it is, and the page is scaled into whatever surface shows it.
 */
export function readBrowserViewport(
  body: Record<string, unknown>,
): WebuiBrowserViewport | undefined {
  const viewport = body.viewport;
  if (!isRecord(viewport)) return undefined;
  return { width: Number(viewport.width), height: Number(viewport.height) };
}

/** The url a validated body carries, as the runtime expects it. */
export function readBrowserWebTabUrl(body: Record<string, unknown>): string {
  return String(body.url);
}

/**
 * The command a validated body carries, as the runtime expects it.
 *
 * A `target` is read as part of the command rather than left on the body, the
 * same way `readBrowserInputCommand` folds its target into the command: the
 * runtime's command contract says which page it acts on, and leaving a wire
 * field loose on the object would let a caller believe it acted on one page
 * while the service drove another.
 */
export function readBrowserCommand(body: Record<string, unknown>): {
  readonly surface: WebuiBrowserSurface;
  readonly command: string;
  readonly params: Record<string, unknown>;
  readonly target?: WebuiBrowserTargetId;
  readonly runId?: string;
} {
  const params = body.params;
  const target = body.target;
  return {
    surface: body.surface as WebuiBrowserSurface,
    command: String(body.command),
    params: isRecord(params) ? params : {},
    ...(isRecord(target) ? { target: target as unknown as WebuiBrowserTargetId } : {}),
    ...(typeof body.runId === "string" && body.runId.length > 0
      ? { runId: body.runId }
      : {}),
  };
}

/** The surface a validated body carries, as the runtime expects it. */
export function readBrowserSurface(body: Record<string, unknown>): WebuiBrowserSurface {
  return body.surface as WebuiBrowserSurface;
}

export { WebuiErrorCode };
