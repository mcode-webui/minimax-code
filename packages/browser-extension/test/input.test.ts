// No browser is involved here: the tab registry and the Debugger API are small
// fakes. They cover what the dispatcher decides — whether a command is allowed to
// touch a tab, and which DevTools commands that turns into — not Chrome's
// behaviour on the other end.

import { describe, expect, it } from "vitest";

import {
  createWebuiBrowserBridgeInputDispatcher,
  type WebuiBrowserBridgeDebuggerApi,
} from "../src/input.js";
import {
  createWebuiBrowserBridgeTargetRegistry,
  webuiBrowserBridgeTargetGenerationStore,
  type WebuiBrowserBridgeTabsApi,
} from "../src/targets.js";
import type { WebuiBrowserBridgeInputCommand } from "../src/protocol.js";

interface SentCommand {
  readonly method: string;
  readonly params: Record<string, unknown> | undefined;
}

function fakeTabs(tabs: { id: number; url?: string; title?: string }[]): WebuiBrowserBridgeTabsApi {
  return {
    async query() {
      return tabs;
    },
    async get(tabId) {
      return tabs.find((tab) => tab.id === tabId);
    },
  };
}

function fakeDebugger(): { sent: SentCommand[]; attached: number[] } & WebuiBrowserBridgeDebuggerApi {
  const sent: SentCommand[] = [];
  const attached: number[] = [];
  return {
    sent,
    attached,
    attach: async (target) => {
      if (target.tabId === undefined) throw new Error("attach without a tab");
      attached.push(target.tabId);
    },
    detach: async () => {},
    sendCommand: async (_target, method, params) => {
      sent.push({ method, params });
      return {};
    },
  };
}

async function registryWith(generation: number) {
  const generations = webuiBrowserBridgeTargetGenerationStore({
    async get() {
      return {};
    },
    async set() {},
    async remove() {},
  });
  const registry = createWebuiBrowserBridgeTargetRegistry({
    browserId: "browser-1",
    tabs: fakeTabs([{ id: 7, url: "https://example.com/", title: "Example" }]),
    generations,
  });
  for (let index = 1; index < generation; index += 1) await registry.noteCommitted(7);
  return registry;
}

describe("input forwarding", () => {
  it("refuses a command aimed at a generation the tab has moved past", async () => {
    const targets = await registryWith(3);
    const browserDebugger = fakeDebugger();
    const dispatcher = createWebuiBrowserBridgeInputDispatcher({
      targets,
      debugger: browserDebugger,
    });

    const result = await dispatcher.dispatch({
      kind: "pointer",
      targetId: "tab-7",
      generation: 2,
      x: 10,
      y: 20,
      button: "left",
      clickCount: 1,
    });

    // A refusal is reported as a refusal, never as a delivery.
    expect(result).toEqual({
      accepted: false,
      error: {
        code: "browser_target_stale",
        message: "target tab-7 is at generation 3, command aimed at 2",
        retryable: false,
      },
    });
    expect(browserDebugger.sent).toEqual([]);
    expect(browserDebugger.attached).toEqual([]);
  });

  it("refuses a command for a target that is not open", async () => {
    const targets = await registryWith(1);
    const browserDebugger = fakeDebugger();
    const dispatcher = createWebuiBrowserBridgeInputDispatcher({
      targets,
      debugger: browserDebugger,
    });

    const result = await dispatcher.dispatch({ kind: "text", targetId: "tab-404", generation: 1, text: "hi" });

    expect(result).toMatchObject({ accepted: false, error: { code: "browser_target_unknown", retryable: false } });
    expect(browserDebugger.sent).toEqual([]);
  });

  it("delivers a current-generation pointer as press and release", async () => {
    const targets = await registryWith(1);
    const browserDebugger = fakeDebugger();
    const dispatcher = createWebuiBrowserBridgeInputDispatcher({
      targets,
      debugger: browserDebugger,
    });

    const result = await dispatcher.dispatch({
      kind: "pointer",
      targetId: "tab-7",
      generation: 1,
      x: 10,
      y: 20,
      button: "left",
      clickCount: 1,
    });

    expect(result).toEqual({ accepted: true });
    expect(browserDebugger.attached).toEqual([7]);
    expect(browserDebugger.sent.map((entry) => entry.method)).toEqual([
      "Input.dispatchMouseEvent",
      "Input.dispatchMouseEvent",
    ]);
    expect(browserDebugger.sent[0]?.params).toMatchObject({
      type: "mousePressed", x: 10, y: 20, button: "left", clickCount: 1,
    });
    expect(browserDebugger.sent[1]?.params).toMatchObject({
      type: "mouseReleased", x: 10, y: 20, button: "left", clickCount: 1,
    });
  });

  it("delivers text through insertText rather than synthesized key events", async () => {
    const targets = await registryWith(1);
    const browserDebugger = fakeDebugger();
    const dispatcher = createWebuiBrowserBridgeInputDispatcher({
      targets,
      debugger: browserDebugger,
    });

    const result = await dispatcher.dispatch({ kind: "text", targetId: "tab-7", generation: 1, text: "héllo" });

    expect(result).toEqual({ accepted: true });
    expect(browserDebugger.sent).toEqual([{ method: "Input.insertText", params: { text: "héllo" } }]);
  });

  it("carries modifiers on a key command", async () => {
    const targets = await registryWith(1);
    const browserDebugger = fakeDebugger();
    const dispatcher = createWebuiBrowserBridgeInputDispatcher({
      targets,
      debugger: browserDebugger,
    });

    await dispatcher.dispatch({
      kind: "key",
      targetId: "tab-7",
      generation: 1,
      key: "a",
      code: "KeyA",
      text: "a",
      modifiers: ["ctrl", "shift"],
    });

    // alt 1, ctrl 2, meta 4, shift 8 — so ctrl+shift is 10.
    expect(browserDebugger.sent.map((entry) => entry.params?.modifiers)).toEqual([10, 10, 10]);
  });

  it("serializes commands aimed at one target", async () => {
    const targets = await registryWith(1);
    const order: string[] = [];
    const browserDebugger: WebuiBrowserBridgeDebuggerApi = {
      attach: async () => {},
      detach: async () => {},
      sendCommand: async () => {
        order.push("sent");
        return {};
      },
    };
    const dispatcher = createWebuiBrowserBridgeInputDispatcher({
      targets,
      debugger: browserDebugger,
    });
    const commands: WebuiBrowserBridgeInputCommand[] = [
      { kind: "text", targetId: "tab-7", generation: 1, text: "one" },
      { kind: "text", targetId: "tab-7", generation: 1, text: "two" },
    ];

    const first = dispatcher.dispatch(commands[0]!);
    const second = dispatcher.dispatch(commands[1]!);

    expect(order).toEqual([]);
    await Promise.all([first, second]);
    await dispatcher.settled("tab-7");
    expect(order).toEqual(["sent", "sent"]);
  });
});
