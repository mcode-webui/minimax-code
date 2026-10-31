// Validating the browser input commands the panel forwards.
//
// The panel does not send DOM events across the wire. It converts them into
// commands, and a command is validated *before* it is forwarded. That is what
// makes "malformed input is rejected rather than forwarded" true: the check
// lives on this side of the boundary, where the shapes are known, instead of
// being hoped for on the far side.
//
// Validation is pure and separate from delivery, because a command that cannot
// be delivered and a command that must not be delivered are different
// failures, and a caller needs to be able to tell them apart.

import {
  WEBUI_BROWSER_SURFACES,
  type WebuiBrowserInputCommand,
  type WebuiBrowserInputModifier,
  type WebuiBrowserSurface,
  type WebuiBrowserTargetId,
} from "../../shared/contracts/browser.js";
import { browserOperationError } from "./errors.js";

const POINTER_BUTTONS = new Set(["left", "middle", "right"]);
const MODIFIERS = new Set<WebuiBrowserInputModifier>(["alt", "ctrl", "meta", "shift"]);

/**
 * Validates one input command.
 *
 * Throws a `WebuiBrowserOperationError` with `browser_command_invalid` when the
 * command does not satisfy the contract. The message says what was wrong; it
 * never echoes the input back, because the input may be text the person typed.
 */
export function validateBrowserInputCommand(
  command: unknown,
): WebuiBrowserInputCommand {
  if (!isRecord(command)) {
    throw browserOperationError(
      "browser_command_invalid",
      "Browser input command must be an object.",
    );
  }
  const kind = command.kind;
  switch (kind) {
    case "pointer":
      return validatePointer(command);
    case "key":
      return validateKey(command);
    case "text":
      return validateText(command);
    default:
      throw browserOperationError(
        "browser_command_invalid",
        `Unknown browser input command kind: ${JSON.stringify(kind ?? null)}.`,
      );
  }
}

function validatePointer(command: Record<string, unknown>): WebuiBrowserInputCommand {
  const x = command.x;
  const y = command.y;
  if (typeof x !== "number" || !Number.isFinite(x) || x < 0) {
    throw browserOperationError(
      "browser_command_invalid",
      "Pointer input needs a finite, non-negative x coordinate.",
    );
  }
  if (typeof y !== "number" || !Number.isFinite(y) || y < 0) {
    throw browserOperationError(
      "browser_command_invalid",
      "Pointer input needs a finite, non-negative y coordinate.",
    );
  }
  const action = command.action;
  if (action !== undefined && !["press", "release", "move", "scroll"].includes(String(action))) {
    throw browserOperationError("browser_command_invalid", "Pointer input has an unknown action.");
  }
  const button = command.button;
  if (action !== "move" && action !== "scroll" && (typeof button !== "string" || !POINTER_BUTTONS.has(button))) {
    throw browserOperationError("browser_command_invalid", "Pointer input needs a button of left, middle or right.");
  }
  const clickCount = command.clickCount;
  if (action === undefined && (typeof clickCount !== "number" || !Number.isInteger(clickCount) || clickCount < 1 || clickCount > 3)) {
    throw browserOperationError("browser_command_invalid", "Pointer input needs a click count between 1 and 3.");
  }
  const deltaX = command.deltaX;
  const deltaY = command.deltaY;
  if (action === "scroll" && (typeof deltaX !== "number" || !Number.isFinite(deltaX) || typeof deltaY !== "number" || !Number.isFinite(deltaY))) {
    throw browserOperationError("browser_command_invalid", "Scroll input needs finite deltas.");
  }
  return {
    kind: "pointer",
    target: readTarget(command.target),
    ...(action ? { action: action as "press" | "release" | "move" | "scroll" } : {}),
    x,
    y,
    ...(typeof button === "string" ? { button: button as "left" | "middle" | "right" } : {}),
    ...(typeof clickCount === "number" ? { clickCount } : {}),
    ...(typeof deltaX === "number" ? { deltaX } : {}),
    ...(typeof deltaY === "number" ? { deltaY } : {}),
  };
}

function validateKey(command: Record<string, unknown>): WebuiBrowserInputCommand {
  const key = command.key;
  if (typeof key !== "string" || key.length === 0 || key.length > 128) {
    throw browserOperationError(
      "browser_command_invalid",
      "Key input needs a non-empty key name.",
    );
  }
  const rawModifiers = command.modifiers;
  if (!Array.isArray(rawModifiers)) {
    throw browserOperationError(
      "browser_command_invalid",
      "Key input needs a modifier list.",
    );
  }
  const modifiers: WebuiBrowserInputModifier[] = [];
  for (const modifier of rawModifiers) {
    if (typeof modifier !== "string" || !MODIFIERS.has(modifier as WebuiBrowserInputModifier)) {
      throw browserOperationError(
        "browser_command_invalid",
        `Unknown key modifier: ${JSON.stringify(modifier ?? null)}.`,
      );
    }
    modifiers.push(modifier as WebuiBrowserInputModifier);
  }
  const code = command.code;
  const text = command.text;
  return {
    kind: "key",
    target: readTarget(command.target),
    key,
    ...(typeof code === "string" && code.length > 0 ? { code } : {}),
    ...(typeof text === "string" ? { text } : {}),
    modifiers,
  };
}

function validateText(command: Record<string, unknown>): WebuiBrowserInputCommand {
  const text = command.text;
  if (typeof text !== "string" || text.length === 0) {
    throw browserOperationError(
      "browser_command_invalid",
      "Text input needs a non-empty text payload.",
    );
  }
  return {
    kind: "text",
    target: readTarget(command.target),
    text,
  };
}

/**
 * Reads the target a command is bound to.
 *
 * A command without a valid target is not a command: an input that is not
 * bound to a page has nowhere to go, and forwarding it would let it land
 * wherever the provider happened to be pointing.
 */
function readTarget(raw: unknown): WebuiBrowserTargetId {
  if (!isRecord(raw)) {
    throw browserOperationError(
      "browser_command_invalid",
      "Browser input needs a target to be bound to.",
    );
  }
  const { surface, browserId, targetId, generation } = raw;
  if (
    typeof surface !== "string" ||
    !WEBUI_BROWSER_SURFACES.includes(surface as WebuiBrowserSurface) ||
    typeof browserId !== "string" ||
    browserId.length === 0 ||
    typeof targetId !== "string" ||
    targetId.length === 0
  ) {
    throw browserOperationError(
      "browser_command_invalid",
      "Browser input needs a target with a surface, a browser and a tab.",
    );
  }
  if (typeof generation !== "number" || !Number.isInteger(generation) || generation < 1) {
    throw browserOperationError(
      "browser_command_invalid",
      "Browser input needs a target generation.",
    );
  }
  return {
    surface: surface as WebuiBrowserSurface,
    browserId,
    targetId,
    generation,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
