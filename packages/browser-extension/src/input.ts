// Pointer, keyboard and text forwarding into the extension's own browser.
//
// Every command is bound to a target identity *and* a generation. A tab that
// navigated or was replaced is a different page even when the browser hands back
// the same tab id, so a command whose generation is no longer current is refused
// outright rather than delivered to whatever is in the tab now. The refusal is
// reported as a refusal — an `input-result` with `accepted: false` and the stable
// error code — because a caller that cannot tell a refusal from a delivery will
// read a lost click as a landed one.
//
// Input reaches the page through the Debugger API's `Input` domain rather than
// synthesized DOM events: only the debugger can produce events the page treats as
// trusted, and a page that ignores untrusted events would show the panel working
// while the Agent saw nothing change.

import {
  webuiBrowserBridgeError,
  type WebuiBrowserBridgeError,
  type WebuiBrowserBridgeInputCommand,
} from "./protocol.js";
import type { WebuiBrowserBridgeTargetRegistry } from "./targets.js";

/** The CDP version this extension attaches with. */
export const WEBUI_BROWSER_BRIDGE_DEBUGGER_VERSION = "1.3";

export interface WebuiBrowserBridgeDebuggerTarget {
  tabId?: number;
}

export interface WebuiBrowserBridgeDebuggerApi {
  attach(target: WebuiBrowserBridgeDebuggerTarget, requiredVersion: string): Promise<void>;
  detach(target: WebuiBrowserBridgeDebuggerTarget): Promise<void>;
  sendCommand(
    target: WebuiBrowserBridgeDebuggerTarget,
    method: string,
    parameters?: Record<string, unknown>,
  ): Promise<unknown>;
}

export type WebuiBrowserBridgeInputResult =
  | { readonly accepted: true }
  | { readonly accepted: false; readonly error: WebuiBrowserBridgeError };

export interface WebuiBrowserBridgeInputDispatcherOptions {
  readonly targets: WebuiBrowserBridgeTargetRegistry;
  readonly debugger: WebuiBrowserBridgeDebuggerApi;
}

export interface WebuiBrowserBridgeInputDispatcher {
  dispatch(command: WebuiBrowserBridgeInputCommand): Promise<WebuiBrowserBridgeInputResult>;
  /** Resolves once nothing is still queued for the target. */
  settled(targetId: string): Promise<void>;
}

const MODIFIER_BITS: Record<string, number> = { alt: 1, ctrl: 2, meta: 4, shift: 8 };

/**
 * Creates the dispatcher.
 *
 * Commands are serialized per target. Two operations against one tab interleaved
 * would let a pointer event land between two halves of a keystroke, which is
 * indistinguishable from a page that ate the input; different tabs stay
 * independent.
 */
export function createWebuiBrowserBridgeInputDispatcher(
  options: WebuiBrowserBridgeInputDispatcherOptions,
): WebuiBrowserBridgeInputDispatcher {
  const queues = new Map<string, Promise<unknown>>();
  const attached = new Map<number, Promise<void>>();

  function attachOnce(tabId: number): Promise<void> {
    const existing = attached.get(tabId);
    if (existing) return existing;
    const attaching = options.debugger.attach({ tabId }, WEBUI_BROWSER_BRIDGE_DEBUGGER_VERSION);
    attached.set(tabId, attaching);
    return attaching;
  }

  async function send(tabId: number, method: string, params: Record<string, unknown>): Promise<void> {
    await options.debugger.sendCommand({ tabId }, method, params);
  }

  async function run(command: WebuiBrowserBridgeInputCommand): Promise<WebuiBrowserBridgeInputResult> {
    const target = await options.targets.lookup(command.targetId);
    if (!target) {
      return {
        accepted: false,
        error: webuiBrowserBridgeError(
          "browser_target_unknown",
          `target ${command.targetId} is not open`,
          false,
        ),
      };
    }
    if (target.generation !== command.generation) {
      return {
        accepted: false,
        error: webuiBrowserBridgeError(
          "browser_target_stale",
          `target ${command.targetId} is at generation ${target.generation}, command aimed at ${command.generation}`,
          false,
        ),
      };
    }
    try {
      await attachOnce(target.tabId);
      await applyCommand(command, target.tabId, send);
      return { accepted: true };
    } catch (cause) {
      return {
        accepted: false,
        error: webuiBrowserBridgeError(
          "browser_provider_failed",
          `input delivery failed: ${cause instanceof Error ? cause.message : String(cause)}`,
          true,
        ),
      };
    }
  }

  return {
    dispatch(command) {
      const previous = queues.get(command.targetId) ?? Promise.resolve();
      const next = previous.then(() => run(command));
      // The queue must not reject: a refusal is a result, and letting it escape
      // here would poison every later command queued behind it.
      queues.set(command.targetId, next.then(noop, noop));
      return next;
    },
    async settled(targetId) {
      await (queues.get(targetId) ?? Promise.resolve());
    },
  };
}

async function applyCommand(
  command: WebuiBrowserBridgeInputCommand,
  tabId: number,
  send: (tabId: number, method: string, params: Record<string, unknown>) => Promise<void>,
): Promise<void> {
  switch (command.kind) {
    case "pointer": {
      const base = { x: command.x, y: command.y };
      if (command.action === "move") {
        await send(tabId, "Input.dispatchMouseEvent", { ...base, type: "mouseMoved", button: "none" });
      } else if (command.action === "scroll") {
        await send(tabId, "Input.dispatchMouseEvent", {
          ...base, type: "mouseWheel", deltaX: command.deltaX, deltaY: command.deltaY, button: "none",
        });
      } else if (command.action === "press" || command.action === "release") {
        await send(tabId, "Input.dispatchMouseEvent", {
          ...base,
          type: command.action === "press" ? "mousePressed" : "mouseReleased",
          button: command.button,
          clickCount: command.clickCount ?? 1,
        });
      } else {
        const click = { ...base, button: command.button, clickCount: command.clickCount };
        await send(tabId, "Input.dispatchMouseEvent", { ...click, type: "mousePressed" });
        await send(tabId, "Input.dispatchMouseEvent", { ...click, type: "mouseReleased" });
      }
      return;
    }
    case "key": {
      const modifiers = (command.modifiers ?? []).reduce((bits, name) => bits | (MODIFIER_BITS[name] ?? 0), 0);
      const base = { key: command.key, code: command.code, modifiers };
      await send(tabId, "Input.dispatchKeyEvent", { ...base, type: command.text ? "keyDown" : "rawKeyDown" });
      if (command.text) {
        await send(tabId, "Input.dispatchKeyEvent", { ...base, type: "char", text: command.text });
      }
      await send(tabId, "Input.dispatchKeyEvent", { ...base, type: "keyUp" });
      return;
    }
    case "text": {
      // `Input.insertText` is the one path that delivers a whole string as the
      // page typed it, so an IME composition in the panel does not arrive as a
      // burst of untrusted key events.
      await send(tabId, "Input.insertText", { text: command.text });
      return;
    }
    default: {
      const exhaustive: never = command;
      throw new Error(`browser bridge: unsupported input command ${JSON.stringify(exhaustive)}`);
    }
  }
}

function noop(): void {
  // Queue bookkeeping only; deliberately silent.
}
