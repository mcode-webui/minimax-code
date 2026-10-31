import { describe, expect, it } from "vitest";

import {
  WebuiBrowserService,
  type WebuiBrowserServiceOptions,
} from "../../src/runtime/browser/browser-service.js";
import { WebuiBrowserOperationError } from "../../src/runtime/browser/errors.js";
import type { WebuiBrowserSurfaceProvider } from "../../src/runtime/browser/isolated-chromium/provider.js";
import type {
  WebuiBrowserAuthorization,
  WebuiBrowserImageFrame,
  WebuiBrowserInputCommand,
  WebuiBrowserTargetId,
  WebuiBrowserWebTabSnapshot,
  WebuiBrowserTargetState,
} from "../../src/shared/contracts/browser.js";

/**
 * A provider that records what it was asked to do.
 *
 * The service is what decides whether a browser may be touched at all; the
 * provider only does what it is told. A fake that records the calls is
 * therefore enough to prove the *decisions*: that a disabled surface is never
 * reached, that a stale target is refused before the provider is asked, and
 * that the input reaches the same provider the panel's frames come from.
 *
 * Tabs and frame handlers are keyed per target rather than held singly, because
 * two runs on one surface may be watching two different tabs at the same time —
 * the case the run-scoped selection exists for.
 */
class RecordingProvider implements WebuiBrowserSurfaceProvider {
  readonly surface = "isolated-chromium" as const;
  readonly browserId = "browser-1";
  readonly inputs: WebuiBrowserInputCommand[] = [];
  readonly commands: { command: string; params: Record<string, unknown> }[] = [];
  readonly startedStreams: string[] = [];
  readonly stoppedStreams: string[] = [];
  readonly targetChangeListeners = new Set<
    (change: { targetId: string; generation: number }) => void
  >();
  /** The tabs this browser has, in listing order. */
  readonly tabIds: readonly string[];
  /** The tabs a command opened, in the order they were opened. */
  readonly openedTabs: string[] = [];
  /** The generation each target has, as the provider's own accounting has it. */
  readonly generations = new Map<string, number>();
  /** One frame handler per open stream, keyed by the tab it watches. */
  readonly frameHandlers = new Map<string, (frame: WebuiBrowserImageFrame) => void>();
  /** The most recently opened stream's handler. */
  frameHandler: ((frame: WebuiBrowserImageFrame) => void) | undefined;
  closed = false;

  constructor(tabIds: readonly string[] = ["tab-1"]) {
    this.tabIds = tabIds;
  }

  onTargetChanged(
    listener: (change: { targetId: string; generation: number }) => void,
  ): () => void {
    this.targetChangeListeners.add(listener);
    return () => {
      this.targetChangeListeners.delete(listener);
    };
  }

  /** Announces that the page behind the target was replaced. */
  announceTargetChange(generation: number, targetId = "tab-1"): void {
    // The provider owns the generation, so the listing reports the new one
    // too — the same way the isolated provider's own accounting moves.
    this.generations.set(targetId, generation);
    for (const listener of this.targetChangeListeners) {
      listener({ targetId, generation });
    }
  }

  /**
   * Reports a generation the provider holds without announcing it.
   *
   * The announcement can be lost: a page that is still loading is observed as
   * a replaced page while it is being attached to, and the announcement
   * arrives before the service has observed the target at all.
   */
  reportGeneration(targetId: string, generation: number): void {
    this.generations.set(targetId, generation);
  }

  async sendCommand(
    _target: unknown,
    command: string,
    params: Record<string, unknown>,
  ): Promise<unknown> {
    this.commands.push({ command, params });
    // The restricted command set reaches `open_tab` as a command; the dedicated
    // `openWebTab` path reaches it as `openTab`. Both are the same page-opening,
    // so both go through the one place that accounts for it.
    if (command === "open_tab") return this.openTab(params);
    return undefined;
  }

  /**
   * Opens a page and answers with its identity.
   *
   * The same answer the isolated provider gives: the surface, the browser, the
   * target and the generation the provider's own accounting has for it.
   */
  async openTab(_params: Record<string, unknown> = {}): Promise<WebuiBrowserTargetId> {
    const targetId = `tab-${this.tabIds.length + this.openedTabs.length + 1}`;
    this.openedTabs.push(targetId);
    return {
      surface: this.surface,
      browserId: this.browserId,
      targetId,
      generation: 1,
    } satisfies WebuiBrowserTargetId;
  }

  async listTargets(): Promise<readonly WebuiBrowserTargetState[]> {
    return [...this.tabIds, ...this.openedTabs].map((targetId) => ({
      id: {
        surface: this.surface,
        browserId: this.browserId,
        targetId,
        generation: this.generations.get(targetId) ?? 1,
      },
      title: `Tab ${targetId}`,
      url: `https://example.test/${targetId}`,
      status: "open" as const,
      selected: true,
    }));
  }

  async startImageStream(
    targetId: string,
    onFrame: (frame: WebuiBrowserImageFrame) => void,
  ): Promise<void> {
    this.startedStreams.push(targetId);
    this.frameHandlers.set(targetId, onFrame);
    this.frameHandler = onFrame;
  }

  /**
   * Pushes one frame down one tab's stream.
   *
   * The frame is pushed on demand rather than on subscription, so a test can
   * decide *when* it arrives — which is the whole point of the fencing: a
   * frame that arrives after the panel moved on has to be dropped, and a frame
   * that belongs to another run's tab must be dropped too.
   */
  pushFrame(generation: number, targetId = "tab-1"): void {
    this.frameHandlers.get(targetId)?.({
      target: {
        surface: this.surface,
        browserId: this.browserId,
        targetId,
        generation,
      },
      data: "AAAA",
      format: "jpeg",
      sequence: 1,
    });
  }

  async stopImageStream(targetId: string): Promise<void> {
    this.stoppedStreams.push(targetId);
    this.frameHandlers.delete(targetId);
  }

  async sendInput(command: WebuiBrowserInputCommand): Promise<void> {
    this.inputs.push(command);
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}

function createService(
  initial: WebuiBrowserAuthorization,
  tabIds: readonly string[] = ["tab-1"],
  edgeProvider?: WebuiBrowserSurfaceProvider,
): {
  service: WebuiBrowserService;
  provider: RecordingProvider;
  state: { authorization: WebuiBrowserAuthorization };
} {
  const provider = new RecordingProvider(tabIds);
  const state = { authorization: initial };
  const options: WebuiBrowserServiceOptions = {
    authorization: {
      read: async () => state.authorization,
      write: async (input) => {
        state.authorization = { ...state.authorization, ...input };
        return state.authorization;
      },
    },
    dataDir: "/tmp/webui-browser-use-test",
    createIsolatedProvider: async () => provider,
    ...(edgeProvider
      ? { createBridgeProvider: async (surface: string) => (surface === "edge" ? edgeProvider : undefined) }
      : {}),
  };
  return { service: new WebuiBrowserService(options), provider, state };
}

/** A tab identity at the generation the fake provider lists it under. */
function tab(targetId: string, generation = 1): WebuiBrowserTargetId {
  return {
    surface: "isolated-chromium",
    browserId: "browser-1",
    targetId,
    generation,
  };
}

/** The target the named run currently has selected, as the list reports it. */
async function selectedTargetOf(
  service: WebuiBrowserService,
  runId?: string,
): Promise<string | undefined> {
  const list = await service.listTargets("isolated-chromium", runId);
  return list.targets.find((target) => target.selected)?.id.targetId;
}

/**
 * The first snapshot the service publishes for one session.
 *
 * Reading the first snapshot is what a client does when it connects: the
 * stream opens with the runtime's current record, so a client that reconnects
 * sees the same thing the first one saw.
 */
async function firstSnapshot(
  service: WebuiBrowserService,
  runId = "run-1",
): Promise<WebuiBrowserWebTabSnapshot> {
  for await (const snapshot of service.watchWebTabs("isolated-chromium", runId)) {
    return snapshot;
  }
  throw new Error("the snapshot stream ended without publishing anything");
}

const ALL_OFF: WebuiBrowserAuthorization = {
  isolatedChromium: false,
  edge: false,
  chrome: false,
  fullCdp: false,
};

describe("browser service", () => {
  it("refuses a surface that is not authorized before touching the provider", async () => {
    const { service, provider } = createService(ALL_OFF);
    await expect(service.listTargets("isolated-chromium")).rejects.toMatchObject({
      code: "browser_surface_not_authorized",
    });
    // The provider was never reached: a refusal that names the switch is
    // different from a browser that failed.
    expect(provider.inputs).toHaveLength(0);
    await service.close();
  });

  it("refuses the input of a surface that is not authorized", async () => {
    const { service, provider } = createService(ALL_OFF);
    await expect(
      service.sendInput({
        kind: "text",
        target: {
          surface: "isolated-chromium",
          browserId: "browser-1",
          targetId: "tab-1",
          generation: 1,
        },
        text: "hello",
      }),
    ).rejects.toMatchObject({ code: "browser_surface_not_authorized" });
    expect(provider.inputs).toHaveLength(0);
    await service.close();
  });

  it("lists the targets of an authorized surface", async () => {
    const { service, provider } = createService({
      ...ALL_OFF,
      isolatedChromium: true,
    });
    const list = await service.listTargets("isolated-chromium");
    expect(list.surface).toBe("isolated-chromium");
    expect(list.targets).toHaveLength(1);
    expect(list.targets[0]?.id.targetId).toBe("tab-1");
    await service.close();
  });

  it("refuses an input aimed at a target whose generation moved on", async () => {
    const { service, provider } = createService({
      ...ALL_OFF,
      isolatedChromium: true,
    });
    await service.listTargets("isolated-chromium");
    // The registry observed the target at generation 1.
    await expect(
      service.sendInput({
        kind: "text",
        target: {
          surface: "isolated-chromium",
          browserId: "browser-1",
          targetId: "tab-1",
          generation: 7,
        },
        text: "hello",
      }),
    ).rejects.toMatchObject({ code: "browser_target_stale" });
    // The input was not delivered to whatever replaced the page.
    expect(provider.inputs).toHaveLength(0);
    await service.close();
  });

  it("delivers an input that names the current generation", async () => {
    const { service, provider } = createService({
      ...ALL_OFF,
      isolatedChromium: true,
    });
    await service.listTargets("isolated-chromium");
    await service.sendInput({
      kind: "text",
      target: {
        surface: "isolated-chromium",
        browserId: "browser-1",
        targetId: "tab-1",
        generation: 1,
      },
      text: "hello",
    });
    expect(provider.inputs).toHaveLength(1);
    expect(provider.inputs[0]?.kind).toBe("text");
    await service.close();
  });

  it("serializes pointer press and release when authorization reads complete out of order", async () => {
    const provider = new RecordingProvider();
    const authorization: WebuiBrowserAuthorization = {
      ...ALL_OFF,
      isolatedChromium: true,
    };
    let holdFirstInputRead = false;
    let inputReads = 0;
    let releaseFirstRead!: () => void;
    const firstReadGate = new Promise<void>((resolve) => {
      releaseFirstRead = resolve;
    });
    let firstReadStarted!: () => void;
    const firstReadStartedSignal = new Promise<void>((resolve) => {
      firstReadStarted = resolve;
    });
    const service = new WebuiBrowserService({
      authorization: {
        read: async () => {
          if (holdFirstInputRead && inputReads++ === 0) {
            firstReadStarted();
            await firstReadGate;
          }
          return authorization;
        },
        write: async () => authorization,
      },
      dataDir: "/tmp/webui-browser-input-order-test",
      createIsolatedProvider: async () => provider,
    });
    await service.listTargets("isolated-chromium");
    holdFirstInputRead = true;
    const target = tab("tab-1");
    const pressed = service.sendInput({
      kind: "pointer",
      action: "press",
      target,
      x: 8,
      y: 9,
      button: "left",
    });
    await firstReadStartedSignal;
    const released = service.sendInput({
      kind: "pointer",
      action: "release",
      target,
      x: 8,
      y: 9,
      button: "left",
    });
    // The second operation must not even read authorization while the first
    // event is held. Without per-target serialization, this call reads it now,
    // then reaches the provider before the delayed press.
    const readsBeforePressCanContinue = inputReads;
    releaseFirstRead();
    await Promise.all([pressed, released]);
    expect(readsBeforePressCanContinue).toBe(1);
    expect(provider.inputs.map((input) => input.kind === "pointer" ? input.action : input.kind)).toEqual([
      "press",
      "release",
    ]);
    await service.close();
  });

  it("refuses a malformed input before it reaches the provider", async () => {
    const { service, provider } = createService({
      ...ALL_OFF,
      isolatedChromium: true,
    });
    await service.listTargets("isolated-chromium");
    await expect(
      service.sendInput({
        kind: "pointer",
        target: {
          surface: "isolated-chromium",
          browserId: "browser-1",
          targetId: "tab-1",
          generation: 1,
        },
        x: Number.NaN,
        y: 10,
        button: "left",
        clickCount: 1,
      }),
    ).rejects.toMatchObject({ code: "browser_command_invalid" });
    expect(provider.inputs).toHaveLength(0);
    await service.close();
  });

  it("stops the provider when its surface is switched off", async () => {
    const { service, provider } = createService({
      ...ALL_OFF,
      isolatedChromium: true,
    });
    await service.listTargets("isolated-chromium");
    await service.writeAuthorization({ isolatedChromium: false });
    expect(provider.closed).toBe(true);
    await expect(service.listTargets("isolated-chromium")).rejects.toMatchObject({
      code: "browser_surface_not_authorized",
    });
    await service.close();
  });

  it("keeps the four switches independent", async () => {
    const { service, state } = createService(ALL_OFF);
    await service.writeAuthorization({ edge: true });
    expect(state.authorization).toEqual({
      isolatedChromium: false,
      edge: true,
      chrome: false,
      fullCdp: false,
    });
    await service.writeAuthorization({ fullCdp: true });
    expect(state.authorization).toEqual({
      isolatedChromium: false,
      edge: true,
      chrome: false,
      fullCdp: true,
    });
    await service.close();
  });

  it("reports the capability matrix per surface", async () => {
    const { service } = createService({
      ...ALL_OFF,
      isolatedChromium: true,
    });
    const { entries } = await service.listCapabilities();
    const isolated = entries.find((entry) => entry.surface === "isolated-chromium");
    const chrome = entries.find((entry) => entry.surface === "chrome");
    expect(isolated?.liveImages).toBe(true);
    expect(isolated?.bridged).toBe(false);
    expect(chrome?.liveImages).toBe(false);
    expect(chrome?.bridged).toBe(true);
    await service.close();
  });

  it("carries the browser error code on the wire", () => {
    const error = new WebuiBrowserOperationError({
      code: "browser_target_stale",
      message: "stale",
      retryable: false,
    });
    expect(error.code).toBe("browser_target_stale");
    expect(error.retryable).toBe(false);
  });

  it("refuses an input recorded against the page a navigation replaced", async () => {
    const { service, provider } = createService({
      ...ALL_OFF,
      isolatedChromium: true,
    });
    await service.listTargets("isolated-chromium");
    // The provider is the party that knows the page was replaced. When it says
    // so, the registry raises the generation and the input recorded against
    // the previous page stops being current.
    provider.announceTargetChange(2);

    await expect(
      service.sendInput({
        kind: "text",
        target: {
          surface: "isolated-chromium",
          browserId: "browser-1",
          targetId: "tab-1",
          generation: 1,
        },
        text: "hello",
      }),
    ).rejects.toMatchObject({ code: "browser_target_stale" });
    expect(provider.inputs).toHaveLength(0);
    await service.close();
  });

  it("delivers an input recorded against the page that is current", async () => {
    const { service, provider } = createService({
      ...ALL_OFF,
      isolatedChromium: true,
    });
    await service.listTargets("isolated-chromium");
    provider.announceTargetChange(2);
    await service.sendInput({
      kind: "text",
      target: {
        surface: "isolated-chromium",
        browserId: "browser-1",
        targetId: "tab-1",
        generation: 2,
      },
      text: "hello",
    });
    expect(provider.inputs).toHaveLength(1);
    await service.close();
  });

  it("refuses a command outside the restricted set while Full CDP is off", async () => {
    const { service, provider } = createService({
      ...ALL_OFF,
      isolatedChromium: true,
    });
    await expect(
      service.sendCommand("isolated-chromium", "Network.setCookies"),
    ).rejects.toMatchObject({ code: "browser_capability_denied" });
    expect(provider.commands).toHaveLength(0);
    await service.close();
  });

  it("allows a command outside the restricted set once Full CDP is on", async () => {
    const { service, provider } = createService({
      ...ALL_OFF,
      isolatedChromium: true,
      fullCdp: true,
    });
    // A command acts on a page, so a page has to be selected first.
    await service.listTargets("isolated-chromium");
    await service.selectTarget({
      surface: "isolated-chromium",
      browserId: "browser-1",
      targetId: "tab-1",
      generation: 1,
    });
    await service.sendCommand("isolated-chromium", "Network.setCookies", {
      name: "a",
    });
    expect(provider.commands).toHaveLength(1);
    expect(provider.commands[0]?.command).toBe("Network.setCookies");
    await service.close();
  });

  it("allows a restricted command whatever the Full CDP switch says", async () => {
    const { service, provider } = createService({
      ...ALL_OFF,
      isolatedChromium: true,
    });
    await service.listTargets("isolated-chromium");
    await service.selectTarget({
      surface: "isolated-chromium",
      browserId: "browser-1",
      targetId: "tab-1",
      generation: 1,
    });
    await service.sendCommand("isolated-chromium", "reload");
    expect(provider.commands.map((entry) => entry.command)).toEqual(["reload"]);
    await service.close();
  });

  it("refuses a command on a surface that is not authorized", async () => {
    const { service, provider } = createService(ALL_OFF);
    await expect(
      service.sendCommand("isolated-chromium", "reload"),
    ).rejects.toMatchObject({ code: "browser_surface_not_authorized" });
    expect(provider.commands).toHaveLength(0);
    await service.close();
  });

  it("does not let Full CDP authorize a surface", async () => {
    const { service, provider } = createService({
      ...ALL_OFF,
      fullCdp: true,
    });
    await expect(
      service.sendCommand("isolated-chromium", "reload"),
    ).rejects.toMatchObject({ code: "browser_surface_not_authorized" });
    expect(provider.commands).toHaveLength(0);
    await service.close();
  });

  it("answers a command that opened a page with that page's identity", async () => {
    const { service, provider } = createService({
      ...ALL_OFF,
      isolatedChromium: true,
    });
    await service.listTargets("isolated-chromium");
    await service.selectTarget(tab("tab-1"));

    const opened = await service.sendCommand("isolated-chromium", "open_tab", {
      url: "https://example.test/",
    });

    // The answer names the page that was created: the surface, the browser,
    // the target and the generation.
    expect(opened.result).toEqual({
      surface: "isolated-chromium",
      browserId: "browser-1",
      targetId: "tab-2",
      generation: 1,
    });
    await service.close();
  });

  it("knows a page that open_tab opened from the identity alone", async () => {
    const { service, provider } = createService({
      ...ALL_OFF,
      isolatedChromium: true,
    });
    await service.listTargets("isolated-chromium");
    await service.selectTarget(tab("tab-1"));

    const opened = await service.sendCommand("isolated-chromium", "open_tab", {
      url: "https://example.test/",
    });
    const identity = opened.result as WebuiBrowserTargetId;

    // The service learned about the page from the answer, so the identity is
    // usable at once — it does not have to wait for the provider to be asked
    // for its list again.
    await service.selectTarget(identity);
    expect(await selectedTargetOf(service)).toBe("tab-2");

    await service.sendInput({ kind: "text", target: identity, text: "hello" });
    expect(provider.inputs).toHaveLength(1);
    expect(provider.inputs[0]?.target.targetId).toBe("tab-2");
    await service.close();
  });

  it("leaves the registry alone for a command that opened no page", async () => {
    const { service, provider } = createService({
      ...ALL_OFF,
      isolatedChromium: true,
    });
    await service.listTargets("isolated-chromium");
    await service.selectTarget(tab("tab-1"));

    // A command whose answer is not an identity must not be turned into one.
    await service.sendCommand("isolated-chromium", "reload");
    await expect(service.selectTarget(tab("tab-9"))).rejects.toMatchObject({
      code: "browser_target_unknown",
    });
    expect(provider.openedTabs).toHaveLength(0);
    await service.close();
  });

  it("publishes the session's web tabs as a snapshot", async () => {
    const { service } = createService({ ...ALL_OFF, isolatedChromium: true });
    await service.listTargets("isolated-chromium");
    await service.selectTarget(tab("tab-1"), "run-1");
    await service.sendCommandToSelection("isolated-chromium", "run-1", "open_tab", {
      url: "https://example.test/second",
    });

    const snapshot = await firstSnapshot(service);
    expect(snapshot.surface).toBe("isolated-chromium");
    expect(snapshot.tabs).toHaveLength(1);
    const [webTab] = snapshot.tabs;
    // Each tab carries its id, its target identity, its title and its url.
    expect(webTab?.id).toBe("tab-2");
    expect(webTab?.target).toEqual({
      surface: "isolated-chromium",
      browserId: "browser-1",
      targetId: "tab-2",
      generation: 1,
    });
    expect(webTab?.title).toBe("Tab tab-2");
    expect(webTab?.url).toBe("https://example.test/tab-2");
    await service.close();
  });

  it("marks the run's selection in the snapshot", async () => {
    const { service } = createService({ ...ALL_OFF, isolatedChromium: true });
    await service.listTargets("isolated-chromium");
    // A run acts on a page it has selected. The bootstrap — a run with no
    // selection opening the first tab — is the Agent's side of this and lands
    // with it; here the run selects first and then opens another tab.
    await service.selectTarget(tab("tab-1"), "run-1");
    await service.sendCommandToSelection("isolated-chromium", "run-1", "open_tab", {
      url: "https://example.test/second",
    });
    const opened = await service.selectTarget(tab("tab-2"), "run-1");

    const snapshot = await firstSnapshot(service, "run-1");
    expect(snapshot.tabs[0]?.selected).toBe(true);
    expect(opened.selected).toBe(true);
    await service.close();
  });

  it("gives a client that reconnects the same snapshot", async () => {
    const { service } = createService({ ...ALL_OFF, isolatedChromium: true });
    await service.listTargets("isolated-chromium");
    // A run acts on a page it has selected. The bootstrap — a run with no
    // selection opening the first tab — is the Agent's side of this and lands
    // with it; here the run selects first and then opens another tab.
    await service.selectTarget(tab("tab-1"), "run-1");
    await service.sendCommandToSelection("isolated-chromium", "run-1", "open_tab", {
      url: "https://example.test/second",
    });

    const first = await firstSnapshot(service, "run-1");
    const second = await firstSnapshot(service, "run-1");
    // A snapshot rather than a delta: applying it twice changes nothing.
    expect(second).toEqual(first);
    await service.close();
  });

  it("drops a closed tab from the next snapshot", async () => {
    const { service } = createService({ ...ALL_OFF, isolatedChromium: true });
    await service.listTargets("isolated-chromium");
    // A run acts on a page it has selected. The bootstrap — a run with no
    // selection opening the first tab — is the Agent's side of this and lands
    // with it; here the run selects first and then opens another tab.
    await service.selectTarget(tab("tab-1"), "run-1");
    await service.sendCommandToSelection("isolated-chromium", "run-1", "open_tab", {
      url: "https://example.test/second",
    });
    expect((await firstSnapshot(service, "run-1")).tabs).toHaveLength(1);

    await service.closeWebTabInSession("isolated-chromium", "run-1", "tab-2");
    expect((await firstSnapshot(service, "run-1")).tabs).toHaveLength(0);
    await service.close();
  });

  it("publishes a new generation when the page behind a web tab is replaced", async () => {
    const { service, provider } = createService({ ...ALL_OFF, isolatedChromium: true });
    await service.listTargets("isolated-chromium");
    // A run acts on a page it has selected. The bootstrap — a run with no
    // selection opening the first tab — is the Agent's side of this and lands
    // with it; here the run selects first and then opens another tab.
    await service.selectTarget(tab("tab-1"), "run-1");
    await service.sendCommandToSelection("isolated-chromium", "run-1", "open_tab", {
      url: "https://example.test/second",
    });
    expect((await firstSnapshot(service, "run-1")).tabs[0]?.target.generation).toBe(1);

    provider.announceTargetChange(2, "tab-2");
    // The web tab is still the same web tab; the page behind it is not.
    const snapshot = await firstSnapshot(service, "run-1");
    expect(snapshot.tabs[0]?.id).toBe("tab-2");
    expect(snapshot.tabs[0]?.target.generation).toBe(2);
    await service.close();
  });

  /** Waits until the stream has subscribed, then pushes one frame. */
  async function pushWhenSubscribed(
    provider: RecordingProvider,
    generation: number,
  ): Promise<void> {
    for (let attempt = 0; attempt < 50; attempt += 1) {
      if (provider.frameHandler) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    provider.pushFrame(generation);
  }

  it("shows a frame that names the page the panel is showing", async () => {
    const { service, provider } = createService({
      ...ALL_OFF,
      isolatedChromium: true,
    });
    await service.listTargets("isolated-chromium");
    await service.selectTarget(tab("tab-1"), "run-panel");

    const controller = new AbortController();
    const received: WebuiBrowserImageFrame[] = [];
    const stream = service.watchFrames("isolated-chromium", tab("tab-1"), controller.signal);
    const consumer = (async () => {
      for await (const frame of stream) {
        received.push(frame);
        if (received.length >= 1) break;
      }
    })();

    await pushWhenSubscribed(provider, 1);
    await new Promise((resolve) => setTimeout(resolve, 50));
    controller.abort();
    await consumer.catch(() => undefined);

    expect(received).toHaveLength(1);
    expect(received[0]?.target.generation).toBe(1);
    await service.close();
  });

  it("drops a frame that names a target the panel is no longer showing", async () => {
    const { service, provider } = createService({
      ...ALL_OFF,
      isolatedChromium: true,
    });
    await service.listTargets("isolated-chromium");
    await service.selectTarget(tab("tab-1"), "run-panel");

    const controller = new AbortController();
    const received: WebuiBrowserImageFrame[] = [];
    const stream = service.watchFrames("isolated-chromium", tab("tab-1"), controller.signal);
    const consumer = (async () => {
      for await (const frame of stream) {
        received.push(frame);
        if (received.length >= 1) break;
      }
    })();

    // The stream is established before the page is replaced: a stream opened
    // for a page that has already been replaced is refused outright, because
    // the picture it would carry is of a page that is gone.
    await waitForStreams(provider, 1);

    // The provider announces that the page behind the tab was replaced. A frame
    // that arrives afterwards still names the previous page, and the panel has
    // already moved past it, so it must not reach the screen.
    provider.announceTargetChange(2);
    provider.pushFrame(1, "tab-1");
    await settleFrames();

    controller.abort();
    await consumer.catch(() => undefined);

    expect(received).toHaveLength(0);
    expect(service.droppedFrameCount("isolated-chromium")).toBe(1);
    await service.close();
  });
});

/**
 * The selection belongs to the run that made it (ADR 0019), so these are the
 * decisions two concurrent runs force on the service: neither may overwrite the
 * other's selection, each stream must carry only its own run's target, and the
 * panel with no run behind it must still have somewhere to put its own.
 */
describe("run-scoped selection", () => {
  const TWO_TABS: WebuiBrowserAuthorization = {
    ...ALL_OFF,
    isolatedChromium: true,
  };

  it("keeps two runs' selections apart on one surface", async () => {
    const { service } = createService(TWO_TABS, ["tab-1", "tab-2"]);
    await service.listTargets("isolated-chromium", "run-a");
    await service.listTargets("isolated-chromium", "run-b");

    await service.selectTarget(tab("tab-1"), "run-a");
    await service.selectTarget(tab("tab-2"), "run-b");

    // Neither write cleared the other: the second selection did not become the
    // surface's one true selection.
    expect(await selectedTargetOf(service, "run-a")).toBe("tab-1");
    expect(await selectedTargetOf(service, "run-b")).toBe("tab-2");
    await service.close();
  });

  it("reports one run's selected flag to that run only", async () => {
    const { service } = createService(TWO_TABS, ["tab-1", "tab-2"]);
    await service.listTargets("isolated-chromium", "run-a");
    await service.selectTarget(tab("tab-2"), "run-a");

    // The panel asks as the run it is following, so the flag it reads is that
    // run's selection and not the other run's.
    expect(await selectedTargetOf(service, "run-a")).toBe("tab-2");
    expect(await selectedTargetOf(service, "run-b")).toBeUndefined();
    await service.close();
  });

  it("opens a person's page in the isolated Chromium, whatever the Agent is working on", async () => {
    // The extension bridge drives the person's own browser through
    // `chrome.debugger` and cannot open a page in it. The panel is the
    // isolated browser's view, so the person typing a url must not be refused
    // because the Agent happens to be working in Edge.
    const edge = new RecordingProvider(["edge-tab"]);
    const { service, provider } = createService(
      { ...ALL_OFF, isolatedChromium: true, edge: true },
      ["tab-1"],
      edge,
    );
    // The Agent is working on Edge.
    const edgeList = await service.listTargets("edge", "run-1");
    const edgeTarget = edgeList.targets.find((entry) => entry.id.targetId === "edge-tab")?.id;
    expect(edgeTarget).toBeDefined();
    await service.selectTarget(edgeTarget!, "run-1");

    const opened = await service.openWebTab(
      "run-1",
      { url: "https://example.test/" },
      undefined,
      "person",
    );

    // The page was opened in the isolated Chromium, not in the browser the
    // Agent is working in.
    expect(opened.target.surface).toBe("isolated-chromium");
    expect(opened.target.browserId).toBe("browser-1");
    // And the run keeps the page it was working on: a person who opens a tab
    // while the run has a selection does not move it.
    await service.close();
  });

  it("keeps the no-run selection separate from every run's", async () => {
    const { service } = createService(TWO_TABS, ["tab-1", "tab-2"]);
    await service.listTargets("isolated-chromium");
    await service.selectTarget(tab("tab-1"));

    // The person pointing at a page before any run exists owns that selection.
    expect(await selectedTargetOf(service)).toBe("tab-1");
    expect(await selectedTargetOf(service, "run-a")).toBeUndefined();

    await service.selectTarget(tab("tab-2"), "run-a");
    // A run's selection does not disturb the panel's own, and the other way
    // round: they are different runs' selections, not two writers of one.
    expect(await selectedTargetOf(service, "run-a")).toBe("tab-2");
    expect(await selectedTargetOf(service)).toBe("tab-1");
    await service.close();
  });

  it("refuses a run's command when that run has selected nothing", async () => {
    const { service, provider } = createService(TWO_TABS, ["tab-1", "tab-2"]);
    await service.listTargets("isolated-chromium", "run-a");
    // Another run's selection is not this run's to act on.
    await service.selectTarget(tab("tab-1"), "run-b");

    await expect(
      service.sendCommandToSelection("isolated-chromium", "run-a", "reload"),
    ).rejects.toMatchObject({ code: "browser_target_unknown" });
    expect(provider.commands).toHaveLength(0);
    await service.close();
  });

  it("gives a run the page a person opened while it had no selection", async () => {
    // The bootstrap, and only that. A run with nothing selected cannot act at
    // all, so the page the person opened becomes its selection — and the run can
    // act on it immediately, which is what the bootstrap is for.
    const { service } = createService(TWO_TABS, ["tab-1", "tab-2"]);
    await service.listTargets("isolated-chromium", "run-a");

    const { target } = await service.openWebTab(
      "run-a",
      { url: "https://example.test" },
      undefined,
      "person",
    );

    expect(await selectedTargetOf(service, "run-a")).toBe(target.targetId);
    await service.close();
  });

  it("leaves a run's selection alone when a person opens a tab and it has one", async () => {
    // The other half of the bootstrap: a person opening a tab is not a way to
    // move the Agent. The page is still the session's web tab and appears in the
    // snapshot — only the selection is left where the run put it.
    const { service } = createService(TWO_TABS, ["tab-1", "tab-2"]);
    await service.listTargets("isolated-chromium", "run-a");
    await service.selectTarget(tab("tab-1"), "run-a");

    const { target } = await service.openWebTab(
      "run-a",
      { url: "https://example.test" },
      undefined,
      "person",
    );

    expect(await selectedTargetOf(service, "run-a")).toBe("tab-1");
    expect((await firstSnapshot(service, "run-a")).tabs.map((entry) => entry.id)).toContain(
      target.targetId,
    );
    await service.close();
  });

  it("moves a run's selection when the Agent itself opens the second page", async () => {
    // The Agent writing its own cell is not the bootstrap and is not conditional:
    // a second `open_tab` has to move the run to the second page or the run
    // could never move on.
    const { service } = createService(TWO_TABS, ["tab-1", "tab-2"]);
    await service.listTargets("isolated-chromium", "run-a");
    await service.openWebTab("run-a", { url: "https://first.test/" });

    const { target } = await service.openWebTab("run-a", { url: "https://second.test/" });

    expect(await selectedTargetOf(service, "run-a")).toBe(target.targetId);
    await service.close();
  });

  it("gives each target's stream only that target's frames", async () => {
    const { service, provider } = createService(TWO_TABS, ["tab-1", "tab-2"]);
    await service.listTargets("isolated-chromium", "run-a");
    await service.listTargets("isolated-chromium", "run-b");
    await service.selectTarget(tab("tab-1"), "run-a");
    await service.selectTarget(tab("tab-2"), "run-b");

    const first = collectFrames(service, tab("tab-1"));
    const second = collectFrames(service, tab("tab-2"));
    await waitForStreams(provider, 2);

    provider.pushFrame(1, "tab-1");
    provider.pushFrame(1, "tab-2");
    await settleFrames();

    expect(first.frames.map((frame) => frame.target.targetId)).toEqual(["tab-1"]);
    expect(second.frames.map((frame) => frame.target.targetId)).toEqual(["tab-2"]);
    await stop(service, [first, second]);
  });

  it("drops a frame that belongs to another target", async () => {
    const { service, provider } = createService(TWO_TABS, ["tab-1", "tab-2"]);
    await service.listTargets("isolated-chromium", "run-a");
    await service.listTargets("isolated-chromium", "run-b");
    await service.selectTarget(tab("tab-1"), "run-a");
    await service.selectTarget(tab("tab-2"), "run-b");

    const first = collectFrames(service, tab("tab-1"));
    const second = collectFrames(service, tab("tab-2"));
    await waitForStreams(provider, 2);

    // The provider hands the first tab's stream a frame of the second tab.
    // Keeping the streams apart is the service's job as well as the
    // provider's, so the fence is against the target the subscriber asked for
    // and the foreign frame is dropped.
    provider.frameHandlers.get("tab-1")?.({
      target: {
        surface: "isolated-chromium",
        browserId: "browser-1",
        targetId: "tab-2",
        generation: 1,
      },
      data: "QlRSQVk=",
      format: "jpeg",
      sequence: 1,
    });
    await settleFrames();

    expect(first.frames).toHaveLength(0);
    expect(second.frames).toHaveLength(0);
    await stop(service, [first, second]);
  });

  it("moves every run's selection with the tab its page navigated", async () => {
    const { service, provider } = createService(TWO_TABS, ["tab-1", "tab-2"]);
    await service.listTargets("isolated-chromium", "run-a");
    await service.listTargets("isolated-chromium", "run-b");
    await service.selectTarget(tab("tab-1"), "run-a");
    await service.selectTarget(tab("tab-2"), "run-b");

    // The tab run A is on navigated, and so did the tab run B is on. Each run's
    // selection follows *its own* tab to the new generation — otherwise run A's
    // tools would refuse its own page as stale, and its stream would drop every
    // frame of it.
    provider.announceTargetChange(2);
    provider.announceTargetChange(2, "tab-2");

    const forA = await service.listTargets("isolated-chromium", "run-a");
    expect(forA.targets.find((target) => target.selected)?.id).toEqual(
      tab("tab-1", 2),
    );
    const forB = await service.listTargets("isolated-chromium", "run-b");
    expect(forB.targets.find((target) => target.selected)?.id).toEqual(
      tab("tab-2", 2),
    );
    await service.close();
  });
});

/**
 * The stream follows the run's selection (a panel that keeps watching the tab
 * the person left is a panel that never shows the tab they moved to), and one
 * run's retarget is one run's business.
 */
describe("the stream of one target", () => {
  const TWO_TABS: WebuiBrowserAuthorization = {
    ...ALL_OFF,
    isolatedChromium: true,
  };

  it("refuses a stream for a target that does not exist", async () => {
    const { service, provider } = createService(TWO_TABS, ["tab-1", "tab-2"]);
    await service.listTargets("isolated-chromium", "run-a");

    // A stream for a target nobody has is a stream that can never deliver a
    // frame, and a panel waiting for one looks like a panel that is broken.
    await expect(drainStream(service, tab("tab-9"))).rejects.toMatchObject({
      code: "browser_target_unknown",
    });
    // The refusal is the whole outcome: nothing was started on the provider.
    expect(provider.startedStreams).toHaveLength(0);
    await service.close();
  });

  it("refuses a stream for a target whose page was replaced", async () => {
    const { service, provider } = createService(TWO_TABS, ["tab-1", "tab-2"]);
    await service.listTargets("isolated-chromium", "run-a");
    provider.announceTargetChange(2, "tab-1");

    await expect(drainStream(service, tab("tab-1"))).rejects.toMatchObject({
      code: "browser_target_stale",
    });
    expect(provider.startedStreams).toHaveLength(0);
    await service.close();
  });

  it("starts the stream for the target the request names", async () => {
    const { service, provider } = createService(TWO_TABS, ["tab-1", "tab-2"]);
    await service.listTargets("isolated-chromium", "run-a");

    const stream = collectFrames(service, tab("tab-2"));
    await waitUntil(() => provider.startedStreams.includes("tab-2"));
    await stop(service, [stream]);

    expect(provider.startedStreams).toEqual(["tab-2"]);
  });

  it("gives two tabs their own pictures, and neither receives the other's frames", async () => {
    const { service, provider } = createService(TWO_TABS, ["tab-1", "tab-2"]);
    await service.listTargets("isolated-chromium", "run-a");

    const first = collectFrames(service, tab("tab-1"));
    const second = collectFrames(service, tab("tab-2"));
    await waitUntil(() => provider.startedStreams.length >= 2);
    expect(new Set(provider.startedStreams)).toEqual(new Set(["tab-1", "tab-2"]));

    provider.pushFrame(1, "tab-1");
    provider.pushFrame(1, "tab-2");
    await settleFrames();

    expect(first.frames.map((frame) => frame.target.targetId)).toEqual(["tab-1"]);
    expect(second.frames.map((frame) => frame.target.targetId)).toEqual(["tab-2"]);
    await stop(service, [first, second]);
  });

  it("drops a frame that names a target the subscriber did not ask for, and counts the drop", async () => {
    const { service, provider } = createService(TWO_TABS, ["tab-1", "tab-2"]);
    await service.listTargets("isolated-chromium", "run-a");

    const stream = collectFrames(service, tab("tab-1"));
    await waitUntil(() => provider.startedStreams.includes("tab-1"));

    // The provider hands a frame to the page that asked for it, so the frame
    // is delivered to this subscriber's own handler directly: the fence is
    // what decides, and it has to be shown deciding on a frame that names
    // another page. The drop is counted, because a stream that quietly stops
    // updating and one that is dropping frames look the same from outside.
    const handler = provider.frameHandlers.get("tab-1");
    handler?.({
      target: tab("tab-2"),
      data: "QlRSQVk=",
      format: "jpeg",
      sequence: 1,
    });
    await settleFrames();

    expect(stream.frames).toHaveLength(0);
    expect(service.droppedFrameCount("isolated-chromium")).toBe(1);
    await stop(service, [stream]);
  });

  it("refuses a frame from a superseded generation", async () => {
    const { service, provider } = createService(TWO_TABS, ["tab-1", "tab-2"]);
    await service.listTargets("isolated-chromium", "run-a");

    const stream = collectFrames(service, tab("tab-1"));
    await waitUntil(() => provider.startedStreams.includes("tab-1"));

    // The page behind the tab was replaced, so the generation moved. The
    // frame that arrives now carries the new generation, and the subscriber
    // asked for the old one: a picture of a page that is gone.
    provider.announceTargetChange(2, "tab-1");
    provider.pushFrame(2, "tab-1");
    await settleFrames();

    expect(stream.frames).toHaveLength(0);
    expect(service.droppedFrameCount("isolated-chromium")).toBe(1);
    await stop(service, [stream]);
  });

  it("leaves the run's selection deciding what the Agent's commands act on", async () => {
    const { service, provider } = createService(TWO_TABS, ["tab-1", "tab-2"]);
    await service.listTargets("isolated-chromium", "run-a");
    await service.selectTarget(tab("tab-2"), "run-a");

    // The stream is keyed by the target the client asked for, and the command
    // path is keyed by the run. They are different cells: the panel shows
    // tab-1, and the Agent still acts on tab-2.
    const stream = collectFrames(service, tab("tab-1"));
    await waitUntil(() => provider.startedStreams.includes("tab-1"));

    await service.sendCommandToSelection("isolated-chromium", "run-a", "reload", {});
    expect(provider.commands.map((entry) => entry.command)).toEqual(["reload"]);
    await stop(service, [stream]);
    await service.close();
  });
});

/**
 * Which surface a run is working on, read out of that run's own selections —
 * the question the Agent's tool path asks, because its tool context carries no
 * surface of its own.
 */
describe("the surface a run is working on", () => {
  const TWO_TABS: WebuiBrowserAuthorization = {
    ...ALL_OFF,
    isolatedChromium: true,
  };

  it("reports the surface the run has a selection on", async () => {
    const { service } = createService(TWO_TABS, ["tab-1", "tab-2"]);
    await service.listTargets("isolated-chromium", "run-a");
    await service.selectTarget(tab("tab-1"), "run-a");
    expect(service.selectionSurfaceOf("run-a")).toBe("isolated-chromium");
    await service.close();
  });

  it("reports nothing for a run that has selected nowhere", async () => {
    const { service } = createService(TWO_TABS, ["tab-1", "tab-2"]);
    await service.listTargets("isolated-chromium", "run-a");
    await service.selectTarget(tab("tab-1"), "run-b");
    // Another run's selection does not make this run work on that surface:
    // the answer has to be about the run that asked.
    expect(service.selectionSurfaceOf("run-a")).toBeUndefined();
    await service.close();
  });

  it("forgets the surface when its provider is stopped", async () => {
    const { service } = createService(TWO_TABS, ["tab-1", "tab-2"]);
    await service.listTargets("isolated-chromium", "run-a");
    await service.selectTarget(tab("tab-1"), "run-a");
    await service.writeAuthorization({ isolatedChromium: false });
    // The browser the run was working on is gone. Reporting it as the run's
    // surface would send the next tool call to a browser nobody authorized.
    expect(service.selectionSurfaceOf("run-a")).toBeUndefined();
    await service.close();
  });

  it("moves a selection onto the page the provider now holds", async () => {
    const { service, provider } = createService({
      ...ALL_OFF,
      isolatedChromium: true,
    });
    await service.listTargets("isolated-chromium", "run-1");
    await service.selectTarget(tab("tab-1"), "run-1");

    // The page behind the tab was replaced, and the announcement that says so
    // was lost — it arrived before the service had observed the target. The
    // provider's listing is then the only thing that knows, and the selection
    // has to follow it: a selection left behind would make the Agent's next
    // action refuse against a page the runtime knows is there.
    provider.reportGeneration("tab-1", 2);
    const list = await service.listTargets("isolated-chromium", "run-1");
    const selected = list.targets.find((entry) => entry.selected);
    expect(selected?.id.targetId).toBe("tab-1");
    expect(selected?.id.generation).toBe(2);
    await service.close();
  });

});

/** One open stream, plus what it has delivered so far. */
interface OpenStream {
  readonly controller: AbortController;
  readonly frames: WebuiBrowserImageFrame[];
}

/** Starts one target's stream and drains it in the background. */
function collectFrames(
  service: WebuiBrowserService,
  target: WebuiBrowserTargetId = tab("tab-1"),
): OpenStream {
  const controller = new AbortController();
  const stream: OpenStream = { controller, frames: [] };
  void (async () => {
    for await (const frame of service.watchFrames(
      "isolated-chromium",
      target,
      controller.signal,
    )) {
      stream.frames.push(frame);
      if (stream.frames.length >= 1) break;
    }
  })().catch(() => undefined);
  return stream;
}

async function waitForStreams(
  provider: RecordingProvider,
  count: number,
): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (provider.startedStreams.length >= count) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/**
 * Waits until a condition holds.
 *
 * The service reacts to a selection change on its own pass through the stream
 * loop, so a test asks for the outcome rather than for a delay — and a test
 * that never gets there fails here instead of asserting on nothing.
 */
async function waitUntil(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("The browser service did not reach the expected state.");
}

/**
 * Reads one run's stream, so a refusal on the way in is a rejection the caller
 * can read: an async generator that is never iterated never runs at all.
 */
function drainStream(
  service: WebuiBrowserService,
  target: WebuiBrowserTargetId = tab("tab-1"),
): Promise<void> {
  const controller = new AbortController();
  return (async () => {
    try {
      for await (const _frame of service.watchFrames(
        "isolated-chromium",
        target,
        controller.signal,
      )) {
        return;
      }
    } finally {
      controller.abort();
    }
  })();
}

/** Gives the streams long enough to have yielded what was pushed. */
async function settleFrames(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 50));
}

async function stop(
  service: WebuiBrowserService,
  streams: readonly OpenStream[],
): Promise<void> {
  for (const stream of streams) stream.controller.abort();
  await new Promise((resolve) => setTimeout(resolve, 20));
  await service.close();
}
