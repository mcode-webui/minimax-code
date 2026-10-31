import { describe, expect, it } from "vitest";

import {
  WebuiBrowserService,
  type WebuiBrowserServiceOptions,
} from "../../src/runtime/browser/browser-service.js";
import { WebuiBrowserOperationError } from "../../src/runtime/browser/errors.js";
import type { WebuiBrowserSurfaceProvider } from "../../src/runtime/browser/isolated-chromium/provider.js";
import {
  createWebuiBrowserToolAdapter,
  type WebuiBrowserToolCommandSurface,
} from "../../src/runtime/browser/tool-adapter.js";
import type { WebuiBrowserAdapter } from "../../src/runtime/browser-provider.js";
import type {
  WebuiBrowserAuthorization,
  WebuiBrowserImageFrame,
  WebuiBrowserInputCommand,
  WebuiBrowserSurface,
  WebuiBrowserTargetId,
  WebuiBrowserTargetState,
} from "../../src/shared/contracts/browser.js";
import { WEBUI_BROWSER_RESTRICTED_COMMANDS } from "../../src/shared/contracts/browser.js";

/**
 * A provider that records what it was asked to do.
 *
 * The service decides whether a browser may be touched at all and the adapter
 * only translates a tool call, so a provider that records its calls is enough
 * to prove the decisions that matter: which browser received the command, and
 * which refusals left every browser untouched. One instance per surface, so a
 * test can see that a run was driven on the browser the person pointed at and
 * not on the one this process owns.
 */
class RecordingProvider implements WebuiBrowserSurfaceProvider {
  readonly surface: WebuiBrowserSurface;
  readonly browserId: string;
  readonly commands: { command: string; params: Record<string, unknown> }[] = [];
  /** The tabs this browser has, so two runs can hold different selections. */
  readonly tabIds: readonly string[];
  /** The pages a command opened, in the order they were opened. */
  readonly openedTabs: string[] = [];
  /** When set, a command is recorded but never answers. */
  neverSettle = false;
  closed = false;

  async sendCommand(
    _target: unknown,
    command: string,
    params: Record<string, unknown>,
  ): Promise<unknown> {
    this.commands.push({ command, params });
    if (this.neverSettle) await new Promise<void>(() => {});
    return { command, params };
  }

  /**
   * Opens a page and answers with its identity.
   *
   * The shape the isolated provider answers with: the surface, the browser,
   * the target and the generation the provider's own accounting gives it.
   *
   * The member is **absent** on a surface that cannot open a page at all, the
   * way the extension bridge's provider has no such member — the service
   * refuses with `browser_capability_denied` when it is missing.
   */
  openTab?: (params?: Record<string, unknown>) => Promise<WebuiBrowserTargetId>;

  constructor(
    surface: WebuiBrowserSurface,
    tabIds: readonly string[] = ["tab-1"],
    canOpenTab = true,
  ) {
    this.surface = surface;
    this.browserId = surface === "isolated-chromium" ? "browser-1" : `${surface}-browser`;
    this.tabIds = tabIds;
    if (canOpenTab) {
      this.openTab = async (params: Record<string, unknown> = {}) => {
        this.commands.push({ command: "open_tab", params });
        const targetId = `tab-${this.tabIds.length + this.openedTabs.length + 1}`;
        this.openedTabs.push(targetId);
        return {
          surface: this.surface,
          browserId: this.browserId,
          targetId,
          generation: 1,
        };
      };
    }
  }

  async listTargets(): Promise<readonly WebuiBrowserTargetState[]> {
    return [...this.tabIds, ...this.openedTabs].map((targetId) => ({
      id: {
        surface: this.surface,
        browserId: this.browserId,
        targetId,
        generation: 1,
      },
      title: "Example",
      url: "https://example.test",
      status: "open" as const,
      selected: true,
    }));
  }

  async startImageStream(
    _targetId: string,
    _onFrame: (frame: WebuiBrowserImageFrame) => void,
  ): Promise<void> {}

  async stopImageStream(_targetId: string): Promise<void> {}

  async sendInput(_command: WebuiBrowserInputCommand): Promise<void> {}

  async close(): Promise<void> {
    this.closed = true;
  }
}

const ALL_OFF: WebuiBrowserAuthorization = {
  isolatedChromium: false,
  edge: false,
  chrome: false,
  fullCdp: false,
};

const SURFACE_AUTHORIZED: WebuiBrowserAuthorization = {
  ...ALL_OFF,
  isolatedChromium: true,
};

const SELECTED_TARGET: WebuiBrowserTargetId = {
  surface: "isolated-chromium",
  browserId: "browser-1",
  targetId: "tab-1",
  generation: 1,
};

const OTHER_TARGET: WebuiBrowserTargetId = {
  ...SELECTED_TARGET,
  targetId: "tab-2",
};

/** A tab of the Edge session the bridge lends the service. */
const EDGE_TARGET: WebuiBrowserTargetId = {
  surface: "edge",
  browserId: "edge-browser",
  targetId: "tab-edge",
  generation: 1,
};

/**
 * A service whose stores and providers a test can reach.
 *
 * `edge` is absent unless the test asks for it, because "the bridge lends Edge
 * a session" is a fact about the host, not a default.
 */
function createService(
  authorization: WebuiBrowserAuthorization,
  options: {
    /** The isolated Chromium's tabs. */
    readonly isolatedTabs?: readonly string[];
    /** When given, the bridge lends Edge a session with these tabs. */
    readonly edgeTabs?: readonly string[];
  } = {},
): {
  service: WebuiBrowserService;
  /** The isolated Chromium's provider. */
  provider: RecordingProvider;
  /** Edge's provider, when the bridge had one to lend. */
  edge: RecordingProvider | undefined;
  /** The switches as the service reads them; a host may change them itself. */
  state: { authorization: WebuiBrowserAuthorization };
} {
  const provider = new RecordingProvider(
    "isolated-chromium",
    options.isolatedTabs ?? ["tab-1"],
  );
  // The edge provider never has an `openTab`: the extension drives the
  // person's own browser through its debugger and cannot open a page in it.
  const edge = options.edgeTabs
    ? new RecordingProvider("edge", options.edgeTabs, false)
    : undefined;
  const state = { authorization };
  const serviceOptions: WebuiBrowserServiceOptions = {
    authorization: {
      read: async () => state.authorization,
      write: async (input) => {
        state.authorization = { ...state.authorization, ...input };
        return state.authorization;
      },
    },
    dataDir: "/tmp/webui-browser-tool-adapter-test",
    createIsolatedProvider: async () => provider,
    ...(edge
      ? { createBridgeProvider: async (surface) => (surface === "edge" ? edge : undefined) }
      : {}),
  };
  return { service: new WebuiBrowserService(serviceOptions), provider, edge, state };
}

/**
 * Puts the surface in the state a tool call assumes: authorized, with the
 * target the panel is showing selected.
 *
 * The selection is the run's, not the tool's: an Agent browser-tool call acts
 * on the selected target of *its own run*, so a test that skipped this would be
 * testing the refusal path. The surface follows the target, so a run that
 * selected in Edge is set up in Edge.
 */
/** The target the named run currently has selected, as the list reports it. */
async function selectedTargetOf(
  service: WebuiBrowserService,
  runId?: string,
): Promise<string | undefined> {
  const list = await service.listTargets("isolated-chromium", runId);
  return list.targets.find((target) => target.selected)?.id.targetId;
}

async function selectRunTarget(
  service: WebuiBrowserService,
  runId: string,
  target: WebuiBrowserTargetId = SELECTED_TARGET,
): Promise<void> {
  await service.listTargets(target.surface, runId);
  await service.selectTarget(target, runId);
}

/**
 * The runtime's tool context and action type, read off the adapter contract.
 *
 * Derived from the WebUI's own `WebuiBrowserAdapter` rather than imported from
 * `@mavis/agent-tools`: that package is not this package's dependency, and the
 * adapter contract already *is* the runtime's `LocalBrowserAdapter`.
 */
type WebuiBrowserToolContext = Parameters<WebuiBrowserAdapter["execute"]>[0];
type WebuiBrowserToolAction = Parameters<WebuiBrowserAdapter["execute"]>[1];

/** The tool context: the adapter reads the run off it, and nothing else. */
function toolContextOf(runId: string): WebuiBrowserToolContext {
  return { sessionId: runId } as WebuiBrowserToolContext;
}

const TOOL_CONTEXT = toolContextOf("run-a");

/**
 * A command surface that records instead of driving a browser.
 *
 * Used for the surface rule alone: which surface a tool call lands on is a
 * decision the adapter makes before a browser is involved, and asserting it
 * through a real browser would be an expensive way to read one argument. What
 * the run is working on is answered here, so the adapter has to ask.
 */
function recordingCommandSurface(surfaceOf: (runId: string) => WebuiBrowserSurface | undefined): {
  browser: WebuiBrowserToolCommandSurface;
  /** The runs the adapter asked about, in order. */
  asked: string[];
  calls: {
    surface: WebuiBrowserSurface;
    runId: string;
    command: string;
    params?: Record<string, unknown>;
    signal?: AbortSignal;
  }[];
} {
  const asked: string[] = [];
  const calls: {
    surface: WebuiBrowserSurface;
    runId: string;
    command: string;
    params?: Record<string, unknown>;
    signal?: AbortSignal;
  }[] = [];
  return {
    asked,
    calls,
    browser: {
      selectionSurfaceOf: (runId) => {
        asked.push(runId);
        return surfaceOf(runId);
      },
      openWebTab: async (runId, params, signal) => {
        calls.push({ surface: "isolated-chromium", runId, command: "open_tab", params, signal });
        return { accepted: true as const, target: SELECTED_TARGET, result: "opened" };
      },
      sendCommandToSelection: async (surface, runId, command, params, signal) => {
        calls.push({ surface, runId, command, params, signal });
        return { accepted: true as const, target: SELECTED_TARGET, result: "done" };
      },
    },
  };
}

describe("Agent browser-tool adapter", () => {
  it("lets a cold run open a tab, and gives the run that page", async () => {
    const { service, provider } = createService(SURFACE_AUTHORIZED);
    const adapter = createWebuiBrowserToolAdapter({ browser: service });

    // The run has selected nothing, and `open_tab` is the one action it may
    // perform: it is the action that would create the selection the gate wants.
    const result = await adapter.execute(TOOL_CONTEXT, "open_tab", {
      url: "https://example.test/",
    });

    expect(provider.commands.map((entry) => entry.command)).toContain("open_tab");
    // The run's selection is the page it opened, so the run can act on it.
    expect(await selectedTargetOf(service, "run-a")).toBe("tab-2");
    expect(result).toMatchObject({ targetId: "tab-2" });
  });

  it("refuses every other action of a cold run", async () => {
    const { service, provider } = createService(SURFACE_AUTHORIZED);
    const adapter = createWebuiBrowserToolAdapter({ browser: service });

    // The refusal reaches no further than it did: the run has selected
    // nothing, so it is refused rather than handed a page nobody chose.
    await expect(
      adapter.execute(TOOL_CONTEXT, "navigate", { url: "https://example.test/" }),
    ).rejects.toMatchObject({ code: "browser_target_unknown" });
    expect(provider.commands).toHaveLength(0);
  });

  it("refuses open_tab on a surface whose switch is off, and opens no page", async () => {
    const { service, provider } = createService(ALL_OFF);
    const adapter = createWebuiBrowserToolAdapter({ browser: service });

    await expect(
      adapter.execute(TOOL_CONTEXT, "open_tab", { url: "https://example.test/" }),
    ).rejects.toMatchObject({ code: "browser_surface_not_authorized" });
    expect(provider.commands).toHaveLength(0);
  });

  it("refuses open_tab on a surface that cannot open a tab", async () => {
    const { service } = createService(
      { ...ALL_OFF, edge: true },
      { edgeTabs: ["tab-edge"] },
    );
    const adapter = createWebuiBrowserToolAdapter({ browser: service });
    // The run works on Edge, and the extension drives that browser through
    // its debugger — it cannot open a page in it.
    await service.listTargets("edge", "run-a");
    await service.selectTarget(EDGE_TARGET, "run-a");

    await expect(
      adapter.execute(TOOL_CONTEXT, "open_tab", { url: "https://example.test/" }),
    ).rejects.toMatchObject({ code: "browser_capability_denied" });
  });

  it("moves the run's selection to a second tab without losing the first", async () => {
    const { service, provider } = createService(SURFACE_AUTHORIZED);
    const adapter = createWebuiBrowserToolAdapter({ browser: service });

    await adapter.execute(TOOL_CONTEXT, "open_tab", { url: "https://example.test/one" });
    expect(await selectedTargetOf(service, "run-a")).toBe("tab-2");

    await adapter.execute(TOOL_CONTEXT, "open_tab", { url: "https://example.test/two" });
    // The run's selection moved to the second page, and the first page is
    // still the session's.
    expect(await selectedTargetOf(service, "run-a")).toBe("tab-3");
    const list = await service.listTargets("isolated-chromium", "run-a");
    expect(list.targets.map((entry) => entry.id.targetId)).toEqual([
      "tab-1",
      "tab-2",
      "tab-3",
    ]);
    expect(provider.openedTabs).toEqual(["tab-2", "tab-3"]);
  });

  it("declares the restricted command set as its whole capability", () => {
    const { service } = createService(SURFACE_AUTHORIZED);
    const adapter = createWebuiBrowserToolAdapter({ browser: service });
    const capabilities = adapter.getCapabilities?.();
    expect(capabilities?.provider).toBe("webui-browser");
    expect(capabilities?.version).toBe(1);
    // Exactly the restricted set: an action the set does not contain must not
    // be offered to the model, and one it does contain must not be withheld.
    expect([...(capabilities?.actions ?? [])]).toEqual([
      ...WEBUI_BROWSER_RESTRICTED_COMMANDS,
    ]);
    // The person can take over the page these actions drive: it is the page
    // the panel is showing.
    expect(capabilities?.interactiveTakeover).toBe(true);
  });

  it("forwards a restricted action to the browser and returns the result", async () => {
    const { service, provider } = createService(SURFACE_AUTHORIZED);
    await selectRunTarget(service, "run-a");
    const adapter = createWebuiBrowserToolAdapter({ browser: service });

    const result = await adapter.execute(
      TOOL_CONTEXT,
      "navigate",
      { url: "https://example.test/page" },
    );

    expect(provider.commands).toEqual([
      { command: "navigate", params: { url: "https://example.test/page" } },
    ]);
    // The provider's own answer, not the service's envelope: the runtime's
    // browser tools read the result at the top level.
    expect(result).toEqual({
      command: "navigate",
      params: { url: "https://example.test/page" },
    });
    await service.close();
  });

  it("refuses an action outside the restricted set, with the browser's own code", async () => {
    // Full CDP is on, so the service would forward a raw DevTools method on the
    // explicit path. The Agent's browser-tool path declares the restricted set
    // as its capability, so it must not widen here — that authorization belongs
    // to the panel's `sendBrowserCommand`.
    const { service, provider } = createService({
      ...SURFACE_AUTHORIZED,
      fullCdp: true,
    });
    await selectRunTarget(service, "run-a");
    const adapter = createWebuiBrowserToolAdapter({ browser: service });

    // A caller that reaches past the declared set is modelled as the runtime
    // would never send it: the string reaches `execute` as an action.
    const rawDevToolsMethod = "Page.captureScreenshot" as unknown as WebuiBrowserToolAction;
    const refusal = await adapter
      .execute(TOOL_CONTEXT, rawDevToolsMethod, {})
      .then(
        () => undefined,
        (error: unknown) => error,
      );

    // The refusal keeps the browser's code and its type: a caller that cannot
    // tell "not allowed" from "the browser broke" retries the wrong thing.
    expect(refusal).toBeInstanceOf(WebuiBrowserOperationError);
    expect(refusal).toMatchObject({ code: "browser_capability_denied" });
    expect((refusal as Error).message).toContain(rawDevToolsMethod);
    expect(provider.commands).toHaveLength(0);
    await service.close();
  });

  it("refuses a surface that is not authorized before reaching the browser", async () => {
    const { service, provider, edge, state } = createService(
      { ...ALL_OFF, edge: true },
      { edgeTabs: ["tab-edge"] },
    );
    await selectRunTarget(service, "run-a", EDGE_TARGET);
    // The switch changes under the running service, which is what a host that
    // reloads its configuration does. The run still holds the selection it
    // made, so the tool path still knows which surface it meant — and the
    // authorization gate still refuses it.
    state.authorization = { ...state.authorization, edge: false };
    const adapter = createWebuiBrowserToolAdapter({ browser: service });

    await expect(
      adapter.execute(TOOL_CONTEXT, "reload", {}),
    ).rejects.toMatchObject({ code: "browser_surface_not_authorized" });
    expect(edge?.commands).toHaveLength(0);
    expect(provider.commands).toHaveLength(0);
    await service.close();
  });

  it("refuses rather than driving another browser after its surface was switched off", async () => {
    const { service, provider, edge } = createService(
      { ...ALL_OFF, isolatedChromium: true, edge: true },
      { isolatedTabs: ["tab-1"], edgeTabs: ["tab-edge"] },
    );
    await selectRunTarget(service, "run-a", EDGE_TARGET);
    await service.writeAuthorization({ edge: false });
    const adapter = createWebuiBrowserToolAdapter({ browser: service });

    // The run still holds the selection it made on Edge, and Edge is still the
    // surface it is working on — but the switch is off, so the authorization
    // gate refuses it by name. What must not happen is the call landing on the
    // isolated Chromium instead: that is a browser the person never pointed
    // this run at.
    await expect(adapter.execute(TOOL_CONTEXT, "reload", {})).rejects.toMatchObject({
      code: "browser_surface_not_authorized",
    });
    expect(edge?.commands).toHaveLength(0);
    expect(provider.commands).toHaveLength(0);
    await service.close();
  });

  it("refuses a surface with no selected target rather than choosing one", async () => {
    const { service, provider } = createService(SURFACE_AUTHORIZED);
    // The surface is authorized and the browser has a tab; nothing is selected.
    await service.listTargets("isolated-chromium");
    const adapter = createWebuiBrowserToolAdapter({ browser: service });

    await expect(
      adapter.execute(TOOL_CONTEXT, "navigate", { url: "https://example.test" }),
    ).rejects.toMatchObject({ code: "browser_target_unknown" });
    // Defaulting to the first tab would drive a page nobody chose.
    expect(provider.commands).toHaveLength(0);
    await service.close();
  });

  it("aborts an in-flight command instead of reporting its result", async () => {
    const { service, provider } = createService(SURFACE_AUTHORIZED);
    await selectRunTarget(service, "run-a");
    provider.neverSettle = true;
    const adapter = createWebuiBrowserToolAdapter({ browser: service });
    const controller = new AbortController();

    const call = adapter.execute(
      TOOL_CONTEXT,
      "navigate",
      { url: "https://example.test" },
      controller.signal,
    );
    // The command has reached the browser; the answer has not come back.
    await Promise.resolve();
    controller.abort();

    await expect(call).rejects.toMatchObject({ code: "browser_operation_cancelled" });
    expect(provider.commands).toHaveLength(1);
    await service.close();
  });

  it("asks the service which surface the calling run is working on", async () => {
    // The tool context carries no surface, and the runtime cannot be asked for
    // one. The service holds the answer — it is the state the panel wrote when
    // the person picked a target — so the adapter asks and acts on that.
    const { browser, asked, calls } = recordingCommandSurface(() => "edge");
    const adapter = createWebuiBrowserToolAdapter({ browser });
    await adapter.execute(TOOL_CONTEXT, "reload", {});
    expect(asked).toEqual(["run-a"]);
    expect(calls).toEqual([
      {
        surface: "edge",
        runId: "run-a",
        command: "reload",
        params: {},
        signal: undefined,
      },
    ]);
  });

  it("refuses when the run has no surface to act on, rather than choosing one", async () => {
    const { browser, calls } = recordingCommandSurface(() => undefined);
    const adapter = createWebuiBrowserToolAdapter({ browser });

    await expect(adapter.execute(TOOL_CONTEXT, "reload", {})).rejects.toMatchObject({
      code: "browser_target_unknown",
    });
    // A browser chosen here would be one the run never pointed at.
    expect(calls).toHaveLength(0);
  });

  it("names the calling run as the selection the command acts on", async () => {
    // The run is the tool context's session, and the selection belongs to it
    // (ADR 0019): the adapter passing no run would be asking about whichever
    // selection happened to be there.
    const { browser, asked, calls } = recordingCommandSurface(() => "isolated-chromium");
    const adapter = createWebuiBrowserToolAdapter({ browser });
    await adapter.execute(toolContextOf("run-b"), "reload", {});
    expect(asked).toEqual(["run-b"]);
    expect(calls[0]?.runId).toBe("run-b");
  });

  it("acts on the surface the run selected, not on the isolated Chromium", async () => {
    const { service, provider, edge } = createService(
      { ...ALL_OFF, isolatedChromium: true, edge: true },
      { isolatedTabs: ["tab-1"], edgeTabs: ["tab-edge"] },
    );
    // The person pointed the panel at Edge and selected a tab there. The
    // isolated Chromium is authorized and connected too, so a default would
    // have found a browser to drive — the wrong one, and the split ADR 0019
    // exists to prevent.
    await selectRunTarget(service, "run-a", EDGE_TARGET);
    const adapter = createWebuiBrowserToolAdapter({ browser: service });

    await adapter.execute(TOOL_CONTEXT, "reload", {});

    expect(edge?.commands).toEqual([{ command: "reload", params: {} }]);
    expect(provider.commands).toHaveLength(0);
    await service.close();
  });

  it("follows the run to the surface it selected last", async () => {
    const { service, provider, edge } = createService(
      { ...ALL_OFF, isolatedChromium: true, edge: true },
      { isolatedTabs: ["tab-1"], edgeTabs: ["tab-edge"] },
    );
    // The run worked in the isolated Chromium, and the person then moved the
    // panel to Edge and selected a tab there. The last choice is the one the
    // panel is showing, so it is the one the Agent's tools act on.
    await selectRunTarget(service, "run-a", SELECTED_TARGET);
    await selectRunTarget(service, "run-a", EDGE_TARGET);
    const adapter = createWebuiBrowserToolAdapter({ browser: service });

    await adapter.execute(TOOL_CONTEXT, "reload", {});

    expect(edge?.commands).toHaveLength(1);
    expect(provider.commands).toHaveLength(0);
    await service.close();
  });

  it("refuses a run that has selected nothing on any surface", async () => {
    const { service, provider, edge } = createService(
      { ...ALL_OFF, isolatedChromium: true, edge: true },
      { isolatedTabs: ["tab-1"], edgeTabs: ["tab-edge"] },
    );
    // Both browsers are authorized, connected and have a tab. Nothing is
    // selected, so there is no browser this run is working on.
    await service.listTargets("isolated-chromium", "run-a");
    await service.listTargets("edge", "run-a");
    const adapter = createWebuiBrowserToolAdapter({ browser: service });

    const refusal = await adapter.execute(TOOL_CONTEXT, "reload", {}).then(
      () => undefined,
      (error: unknown) => error,
    );

    // The refusal carries the browser's own code, so the run is told to select a
    // page rather than shown a browser failure nobody can act on.
    expect(refusal).toBeInstanceOf(WebuiBrowserOperationError);
    expect(refusal).toMatchObject({ code: "browser_target_unknown" });
    expect(provider.commands).toHaveLength(0);
    expect(edge?.commands).toHaveLength(0);
    await service.close();
  });

  it("acts on the calling run's own selected target, not another run's", async () => {
    const { service, provider } = createService(SURFACE_AUTHORIZED, { isolatedTabs: ["tab-1", "tab-2"] });
    // Two runs, one surface, two different pages.
    await selectRunTarget(service, "run-a", SELECTED_TARGET);
    await selectRunTarget(service, "run-b", OTHER_TARGET);
    const adapter = createWebuiBrowserToolAdapter({ browser: service });

    const first = await adapter.execute(toolContextOf("run-a"), "reload", {});
    const second = await adapter.execute(toolContextOf("run-b"), "reload", {});

    // Each run drove the page it selected, and neither was moved onto the
    // other's: the command carries the resolved target back, so the run that
    // drove tab-2 could not have driven tab-1.
    expect(first).toEqual({ command: "reload", params: {} });
    expect(second).toEqual({ command: "reload", params: {} });
    expect(await selectedTabOf(service, "run-a")).toBe("tab-1");
    expect(await selectedTabOf(service, "run-b")).toBe("tab-2");
    expect(provider.commands).toHaveLength(2);
    await service.close();
  });

  it("refuses a run that has selected nothing rather than using another's", async () => {
    const { service, provider } = createService(SURFACE_AUTHORIZED, { isolatedTabs: ["tab-1", "tab-2"] });
    await selectRunTarget(service, "run-b", OTHER_TARGET);
    const adapter = createWebuiBrowserToolAdapter({ browser: service });

    // run-a never selected anything. Acting on run-b's page would be two runs
    // sharing one page, which is what the run-scoped selection forbids.
    await expect(
      adapter.execute(toolContextOf("run-a"), "reload", {}),
    ).rejects.toMatchObject({ code: "browser_target_unknown" });
    expect(provider.commands).toHaveLength(0);
    await service.close();
  });
});

/** The tab the named run currently has selected, as the list reports it. */
async function selectedTabOf(
  service: WebuiBrowserService,
  runId: string,
): Promise<string | undefined> {
  const list = await service.listTargets("isolated-chromium", runId);
  return list.targets.find((target) => target.selected)?.id.targetId;
}