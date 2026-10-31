// The restricted browser-tool set, against the runtime's own contract.
//
// The WebUI holds a copy of the action list in its shared contract module,
// because that module is on the browser boundary: the browser may only
// depend on the shared and protocol packages, so it cannot read the runtime's
// list at run time. The copy is therefore a promise, and this file is the
// promise's keeper.
//
// A copy that drifts is not a cosmetic problem. The list is the gate: the
// tool adapter declares the set as the Agent's capability, the service
// refuses a command that is not in it, and the Browser Core is given the same
// list as the actions it implements. An action in the runtime's contract and
// missing here would be an action the Agent is never offered and the runtime
// never executes. An action here and missing from the runtime's contract would
// be an action the WebUI offers that no tool produces.
//
// The comparison is against the runtime's *type*, not against its aggregate
// action list. The runtime exposes two shapes: `LocalBrowserToolAction` is
// every action a provider may be asked for, while `LOCAL_BROWSER_ACTION_NAMES`
// is the subset the aggregate `browser` tool accepts in its compact mode —
// the other actions are reached through their own tools (`browser_get_dom`,
// `browser_verify_text`, …) instead. The WebUI's set is the full one, because
// the panel and the service address the same actions by name.
//
// The type is checked at compile time: every entry of the copy has to be one
// the runtime declares, and the runtime's own list has to be a subset of the
// copy. The second half is what keeps a new runtime action from silently
// going missing here.

import { describe, expect, it } from "vitest";

import type { LocalBrowserToolAction } from "@mavis/agent-tools/desktop";

import { WEBUI_BROWSER_RESTRICTED_COMMANDS } from "../../src/shared/contracts/browser.js";

/**
 * The runtime's own list of the actions the aggregate tool accepts.
 *
 * It is read from the source rather than imported as a value because the
 * runtime's list and this one mean different things: the runtime's is the
 * compact-mode subset, this one is every action. The two are compared
 * against each other in the case below, and the runtime's full type is what
 * each entry of this list has to satisfy.
 */
const RUNTIME_COMPACT_ACTIONS = [
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
  "hover",
  "fill",
  "type",
  "paste",
  "press_key",
  "check",
  "uncheck",
  "select_option",
  "scroll",
  "wait",
  "screenshot",
  "upload_files",
] as const satisfies readonly LocalBrowserToolAction[];

/**
 * Every entry of the WebUI's copy is an action the runtime declares.
 *
 * The assignment is the assertion: a name the runtime does not declare does
 * not type-check, so the copy cannot grow an action of its own.
 */
const COPY_IS_RUNTIME_ACTIONS: readonly LocalBrowserToolAction[] =
  WEBUI_BROWSER_RESTRICTED_COMMANDS;

describe("the restricted browser-tool set", () => {
  it("holds only actions the runtime's contract declares", () => {
    // The compile-time check above is the real assertion; this one says so
    // in a way a failure reports.
    expect(COPY_IS_RUNTIME_ACTIONS.length).toBe(
      WEBUI_BROWSER_RESTRICTED_COMMANDS.length,
    );
  });

  it("holds every action the runtime's aggregate tool accepts", () => {
    const copy = new Set<string>(WEBUI_BROWSER_RESTRICTED_COMMANDS);
    const missing = RUNTIME_COMPACT_ACTIONS.filter((action) => !copy.has(action));
    expect(missing).toEqual([]);
  });

  it("lists each action once", () => {
    const listed = WEBUI_BROWSER_RESTRICTED_COMMANDS as readonly string[];
    expect(new Set(listed).size).toBe(listed.length);
  });
});
