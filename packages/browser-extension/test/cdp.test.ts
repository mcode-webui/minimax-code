// The bridge's DevTools command path.
//
// `chrome.debugger` exposes only a subset of the DevTools domains, so the
// extension decides for itself which commands it will run. These tests pin
// that decision: a command in the subset is sent, a command outside it is
// refused **before** any browser call is made, and a browser that refuses a
// command comes back as a refusal rather than a success.

import { describe, expect, it } from "vitest";

import {
  WEBUI_BROWSER_BRIDGE_CDP_COMMANDS,
  createWebuiBrowserBridgeCdpDispatcher,
} from "../src/cdp.js";
import type { WebuiBrowserBridgeDebuggerApi } from "../src/input.js";

/** A debugger that records what it was asked to do. */
function recordingDebugger(
  behaviour: (method: string) => "ok" | "refuse" = () => "ok",
): WebuiBrowserBridgeDebuggerApi & { readonly sent: string[]; readonly attached: number[] } {
  const sent: string[] = [];
  const attached: number[] = [];
  return {
    sent,
    attached,
    async attach(target: { readonly tabId?: number }) {
      attached.push(target.tabId ?? -1);
    },
    async detach() {
      // The dispatcher keeps its attachment; detaching is the browser's call.
    },
    async sendCommand(
      _target: { readonly tabId?: number },
      method: string,
    ) {
      sent.push(method);
      if (behaviour(method) === "refuse") {
        throw new Error(`the browser does not support ${method}`);
      }
      return { echoed: method };
    },
  };
}

describe("the bridge's DevTools commands", () => {
  it("sends a command that is in the supported subset", async () => {
    const debuggerApi = recordingDebugger();
    const dispatcher = createWebuiBrowserBridgeCdpDispatcher({
      debugger: debuggerApi,
      version: "1.3",
    });
    const outcome = await dispatcher.dispatch({ tabId: 7 }, "Runtime.evaluate", {
      expression: "1 + 1",
    });
    expect(outcome).toEqual({ accepted: true, result: { echoed: "Runtime.evaluate" } });
    expect(debuggerApi.sent).toEqual(["Runtime.evaluate"]);
    expect(debuggerApi.attached).toEqual([7]);
  });

  it("refuses a command outside the subset without asking the browser", async () => {
    const debuggerApi = recordingDebugger();
    const dispatcher = createWebuiBrowserBridgeCdpDispatcher({
      debugger: debuggerApi,
      version: "1.3",
    });
    const outcome = await dispatcher.dispatch({ tabId: 7 }, "Browser.setPermission", {});
    expect(outcome.accepted).toBe(false);
    // The refusal says the command will never work, which is a different
    // thing from a failure that might.
    expect(outcome).toMatchObject({ unsupported: true });
    expect(debuggerApi.sent).toEqual([]);
  });

  it("reports a browser refusal as a failure, not as an unsupported command", async () => {
    const debuggerApi = recordingDebugger((method) =>
      method === "Runtime.evaluate" ? "refuse" : "ok",
    );
    const dispatcher = createWebuiBrowserBridgeCdpDispatcher({
      debugger: debuggerApi,
      version: "1.3",
    });
    const outcome = await dispatcher.dispatch({ tabId: 7 }, "Runtime.evaluate", {});
    expect(outcome.accepted).toBe(false);
    // The browser refused it, so the command may work elsewhere; it is not the
    // same as "the extension will never run this".
    expect(outcome).not.toMatchObject({ unsupported: true });
  });

  it("reports a tab it cannot attach to as a refusal", async () => {
    const debuggerApi: WebuiBrowserBridgeDebuggerApi = {
      async attach() {
        throw new Error("the tab is not debuggable");
      },
      async detach() {},
      async sendCommand() {
        return undefined;
      },
    };
    const dispatcher = createWebuiBrowserBridgeCdpDispatcher({
      debugger: debuggerApi,
      version: "1.3",
    });
    const outcome = await dispatcher.dispatch({ tabId: 7 }, "Runtime.evaluate", {});
    expect(outcome.accepted).toBe(false);
    expect(outcome).not.toMatchObject({ unsupported: true });
  });

  it("attaches once per tab rather than once per command", async () => {
    const debuggerApi = recordingDebugger();
    const dispatcher = createWebuiBrowserBridgeCdpDispatcher({
      debugger: debuggerApi,
      version: "1.3",
    });
    await dispatcher.dispatch({ tabId: 7 }, "Runtime.evaluate", {});
    await dispatcher.dispatch({ tabId: 7 }, "DOM.getDocument", {});
    await dispatcher.dispatch({ tabId: 8 }, "DOM.getDocument", {});
    // One attachment per tab, not per command.
    expect(debuggerApi.attached).toEqual([7, 8]);
  });

  it("keeps the supported subset explicit", () => {
    // A subset that is not explicit is not a restriction.
    expect(WEBUI_BROWSER_BRIDGE_CDP_COMMANDS.has("Runtime.evaluate")).toBe(true);
    expect(WEBUI_BROWSER_BRIDGE_CDP_COMMANDS.has("Page.captureScreenshot")).toBe(false);
    expect(WEBUI_BROWSER_BRIDGE_CDP_COMMANDS.has("Browser.setPermission")).toBe(false);
  });
});
