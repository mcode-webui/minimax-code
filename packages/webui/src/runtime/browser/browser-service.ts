// The browser service: the one place that owns the browser surfaces.
//
// The service owns three things and keeps them consistent:
//
//   * the **authorization** — the four switches, read from and written to the
//     host's configuration so they survive a restart;
//   * the **providers** — one per surface, started only when the surface is
//     authorized and stopped when it is not;
//   * the **target registry** — the identity and generation of every target,
//     which is what makes a stale reference detectable.
//
// Every browser path — the panel's image stream, the panel's input, the
// Agent's browser tools — goes through this service. That is what keeps the
// panel and the Agent on the same browser session: there is one session, and
// both sides address it here.
//
// The **selection** is scoped to the run that made it, per surface (ADR 0019:
// the Agent run owns the target selection, and the panel follows the active
// run's target). A run is the Agent session id; the panel before any run is
// active has one selection of its own, named `WEBUI_BROWSER_NO_RUN_ID` rather
// than left as an empty string, because "no run" is a real caller and not a
// missing argument. Two concurrent runs on one surface therefore have two
// selections: neither overwrites the other, each run's tools act on its own
// target, and each stream carries only the frames of the target its own run
// selected.
//
// The selection is also how a tool call learns which browser to act on. The
// Agent's tool context carries no surface, so the adapter asks the service which
// surface this run has selected on, and is refused when the run has selected
// nowhere. The answer is read out of the same state the panel wrote, which is
// what stops the tool path and the panel from naming different browsers.
//
// A surface that is not authorized is refused before anything is attempted, so
// "you did not switch this on" is distinguishable from "the browser broke".

import {
  isSameWebuiBrowserTarget,
  WEBUI_BROWSER_RESTRICTED_COMMANDS,
  type WebuiBrowserAuthorization,
  type WebuiBrowserCapabilityEntry,
  type WebuiBrowserImageFrame,
  type WebuiBrowserInputCommand,
  type WebuiBrowserSurface,
  type WebuiBrowserTabOpener,
  type WebuiBrowserTargetId,
  type WebuiBrowserViewport,
  type WebuiBrowserTargetList,
  type WebuiBrowserTargetState,
  type WebuiBrowserWebTab,
  type WebuiBrowserWebTabClose,
  type WebuiBrowserWebTabSnapshot,
} from "../../shared/contracts/browser.js";
import {
  browserOperationError,
  WebuiBrowserOperationError,
} from "./errors.js";
import {
  isBrowserCommandAllowed,
  isBrowserSurfaceUsable,
  normalizeBrowserAuthorization,
} from "./authorization.js";
import { validateBrowserInputCommand } from "./input.js";
import { WebuiBrowserTargetRegistry } from "./target-registry.js";
import {
  WebuiIsolatedChromiumProvider,
  type WebuiBrowserSurfaceProvider,
} from "./isolated-chromium/provider.js";

/**
 * How many frames the stream may hold while the consumer is behind.
 *
 * The queue keeps the newest frame per target, so the limit is a bound on how
 * many *targets* a stream may carry, not on how much image data it may hold.
 */
const WEBUI_BROWSER_FRAME_QUEUE_LIMIT = 32;

/**
 * The run whose selection the panel is showing when no run is active.
 *
 * The panel can select a target before any run exists — the person is pointing
 * at a page, and nothing is driving it yet — so the selection needs an owner
 * even then. A named run rather than an absent one keeps the key space total:
 * every selection read and write can ask for a run and get an answer, and there
 * is never a second, host-wide "current target" beside it.
 */
export const WEBUI_BROWSER_NO_RUN_ID = "webui-browser-no-run";

/**
 * What one run has selected on one surface, and when it made that choice.
 *
 * The order is not a second selection — the target beside it is the one the run
 * has — it only says which of a run's surfaces was chosen last, which is what
 * answers "which browser is this run working on" for a run that has followed the
 * panel from one surface to another.
 */
interface WebuiBrowserRunSelection {
  readonly target: WebuiBrowserTargetId;
  readonly order: number;
}

/** How the service reads and writes the authorization. */
export interface WebuiBrowserAuthorizationStore {
  read(): Promise<WebuiBrowserAuthorization>;
  write(
    input: Partial<WebuiBrowserAuthorization>,
  ): Promise<WebuiBrowserAuthorization>;
}

/** What the service needs to start an isolated browser. */
export interface WebuiBrowserServiceOptions {
  readonly authorization: WebuiBrowserAuthorizationStore;
  /** The directory the isolated browser keeps its profile under. */
  readonly dataDir: string;
  /**
   * How the isolated browser is started.
   *
   * Injectable so a test can supply a provider that does not launch a real
   * browser. The default launches Chromium.
   */
  readonly createIsolatedProvider?: (
    options: { readonly dataDir: string; readonly chromePath?: string },
  ) => Promise<WebuiBrowserSurfaceProvider>;
  /**
   * How the external browsers are reached.
   *
   * The Edge and Chrome surfaces are the person's own browsers, reached
   * through the extension bridge. The bridge owns the sessions; this factory
   * is how the service borrows one as a provider, so that the panel and the
   * Agent's tools address the same session the extension is driving.
   *
   * Returning `undefined` means "no browser of that kind is connected right
   * now" — which is different from "that surface is not authorized" and is
   * reported as such.
   */
  readonly createBridgeProvider?: (
    surface: "edge" | "chrome",
  ) => Promise<WebuiBrowserSurfaceProvider | undefined>;
  /**
   * The bridge's pairing lifecycle.
   *
   * The switches own the pairings: turning Edge on mints Edge's credential and
   * turning Edge off revokes it and closes Edge's sessions. The service is
   * where the two meet, because the service is where the switches live.
   */
  readonly bridge?: {
    enableSurface?(surface: "edge" | "chrome"): Promise<void>;
    disableSurface?(surface: "edge" | "chrome"): Promise<void>;
    /**
     * Re-adopts the credential the surface already had.
     *
     * The startup path. A host that restarts must keep the credential the
     * extension still holds, so the startup path restores rather than rotates.
     */
    restoreSurface?(surface: "edge" | "chrome"): Promise<void>;
  };
  /** The Chrome executable the isolated browser should use. */
  readonly chromePath?: string;
}

/**
 * The browser service.
 *
 * One instance per host. It is the thing the server's browser operations call.
 */
export class WebuiBrowserService {
  readonly #options: WebuiBrowserServiceOptions;
  readonly #registry = new WebuiBrowserTargetRegistry();
  readonly #providers = new Map<WebuiBrowserSurface, WebuiBrowserSurfaceProvider>();
  /** Input events for one page must reach its provider in the order received. */
  readonly #inputQueues = new Map<string, Promise<void>>();
  /**
   * The target each run has selected, per surface and then per run.
   *
   * Nested rather than flattened into one key because both halves are the
   * scope: a surface alone would let two runs overwrite each other's selection,
   * and a run alone would let one run select on two surfaces at once.
   */
  readonly #selected = new Map<
    WebuiBrowserSurface,
    Map<string, WebuiBrowserRunSelection>
  >();
  /** How many selections have been made; orders the run's own writes. */
  #selectionOrder = 0;
  /** Which external surfaces the service has turned on, per surface. */
  readonly #bridgeSurfaces = new Map<"edge" | "chrome", boolean>();
  /** The frame subscribers, per surface and then per target. */
  readonly #frameSubscribers = new Map<
    WebuiBrowserSurface,
    Map<string, Set<(frame: WebuiBrowserImageFrame) => void>>
  >();
  /**
   * The provider-side frame handler, per surface and then per target.
   *
   * One screencast per page, shared by that page's subscribers: the provider
   * holds one frame handler per page, so two subscriptions for the same page
   * would otherwise take each other's frames away.
   */
  readonly #frameHandlers = new Map<
    WebuiBrowserSurface,
    Map<string, (frame: WebuiBrowserImageFrame) => void>
  >();
  /** How many frames each surface dropped, per surface. */
  readonly #droppedFrames = new Map<WebuiBrowserSurface, number>();
  /**
   * The web tabs each session has open, per surface and then per run.
   *
   * The runtime owns this record. The strip renders what the runtime
   * publishes, so a client that kept its own copy of the open tabs would be a
   * second authority about what is open — and two authorities disagree at
   * exactly the moment a tab is closed.
   */
  readonly #webTabs = new Map<
    WebuiBrowserSurface,
    Map<string, Map<string, WebuiBrowserTargetId>>
  >();
  /** The web-tab snapshot subscribers, per surface and then per run. */
  readonly #webTabSubscribers = new Map<
    WebuiBrowserSurface,
    Map<string, Set<() => void>>
  >();

  constructor(options: WebuiBrowserServiceOptions) {
    this.#options = options;
  }

  /** The per-run selections of one surface, created on first use. */
  #runSelections(
    surface: WebuiBrowserSurface,
  ): Map<string, WebuiBrowserRunSelection> {
    const existing = this.#selected.get(surface);
    if (existing) return existing;
    const created = new Map<string, WebuiBrowserRunSelection>();
    this.#selected.set(surface, created);
    return created;
  }

  /**
   * Moves a selection onto the page the runtime currently holds.
   *
   * The generation moves when the page behind a target is replaced, and the
   * selection follows it: the selection names a page, and a page that
   * navigated is still the same page. A selection left behind would make the
   * Agent's next action refuse against a page the runtime knows is there.
   */
  #followGeneration(identity: WebuiBrowserTargetState): void {
    for (const selections of this.#selected.values()) {
      for (const [runId, selection] of [...selections]) {
        if (selection.target.targetId !== identity.id.targetId) continue;
        if (selection.target.generation === identity.id.generation) continue;
        selections.set(runId, { ...selection, target: identity.id });
      }
    }
  }

  /** What one run has selected on one surface, if it has selected anything. */
  #selectionOf(
    surface: WebuiBrowserSurface,
    runId: string,
  ): WebuiBrowserTargetId | undefined {
    return this.#selected.get(surface)?.get(runId)?.target;
  }

  /** The web tabs one session has open on one surface. */
  #webTabsOf(
    surface: WebuiBrowserSurface,
    runId: string,
  ): Map<string, WebuiBrowserTargetId> | undefined {
    return this.#webTabs.get(surface)?.get(runId);
  }

  /**
   * Records a page a session opened as one of its web tabs.
   *
   * The identity is the one the provider answered `open_tab` with, so the
   * runtime's record names the page that was actually created rather than one
   * it inferred afterwards.
   */
  #recordWebTab(
    surface: WebuiBrowserSurface,
    runId: string,
    target: WebuiBrowserTargetId,
  ): void {
    const runs = this.#webTabs.get(surface) ?? new Map<string, Map<string, WebuiBrowserTargetId>>();
    const tabs = runs.get(runId) ?? new Map<string, WebuiBrowserTargetId>();
    tabs.set(target.targetId, target);
    runs.set(runId, tabs);
    this.#webTabs.set(surface, runs);
    this.#publishWebTabs(surface, runId);
  }

  /** Wakes the snapshot subscribers of one session. */
  #publishWebTabs(surface: WebuiBrowserSurface, runId: string): void {
    const subscribers = this.#webTabSubscribers.get(surface)?.get(runId);
    if (!subscribers) return;
    for (const wake of [...subscribers]) wake();
  }

  /**
   * The session's web tabs, as a snapshot.
   *
   * The target identities come from the runtime's own record; the titles and
   * urls come from the provider, which is the only party that knows what a
   * page is showing. A tab the provider no longer lists is still published,
   * with the title and url it last had — the runtime's record of what is open
   * is not the provider's to decide.
   */
  async #webTabSnapshot(
    surface: WebuiBrowserSurface,
    runId: string,
  ): Promise<WebuiBrowserWebTabSnapshot> {
    const tabs = this.#webTabsOf(surface, runId);
    const selected = this.#selectionOf(surface, runId);
    const provider = this.#providers.get(surface);
    const listed = provider ? await provider.listTargets() : [];
    const byTargetId = new Map(listed.map((entry) => [entry.id.targetId, entry]));
    const published = [...(tabs?.values() ?? [])].map((target) => {
      const state = byTargetId.get(target.targetId);
      return {
        id: target.targetId,
        // The generation is the page's own, so a page that navigated is
        // published with its new generation while the web tab stays the same
        // web tab.
        target: { ...target, generation: state?.id.generation ?? target.generation },
        title: state?.title ?? "",
        url: state?.url ?? "",
        ...(state?.faviconUrl ? { faviconUrl: state.faviconUrl } : {}),
        ...(state?.canGoBack !== undefined ? { canGoBack: state.canGoBack } : {}),
        ...(state?.canGoForward !== undefined ? { canGoForward: state.canGoForward } : {}),
        selected: selected
          ? selected.surface === target.surface &&
            selected.browserId === target.browserId &&
            selected.targetId === target.targetId
          : false,
      } satisfies WebuiBrowserWebTab;
    });
    return { surface, tabs: published };
  }

  /**
   * The session's web tabs, on a stream.
   *
   * A snapshot rather than a delta: the list is small, and a snapshot is
   * idempotent, so a client that reconnects receives the same snapshot and
   * applying it twice changes nothing. The stream publishes only when the
   * snapshot actually differs, so a client is not woken for a change that did
   * not happen.
   */
  async *watchWebTabs(
    surface: WebuiBrowserSurface,
    runId: string = WEBUI_BROWSER_NO_RUN_ID,
    signal?: AbortSignal,
  ): AsyncIterable<WebuiBrowserWebTabSnapshot> {
    const authorization = await this.readAuthorization();
    if (!isBrowserSurfaceUsable(authorization, surface)) {
      throw browserOperationError(
        "browser_surface_not_authorized",
        `Browser surface "${surface}" is not authorized.`,
      );
    }
    await this.#ensureProvider(surface);

    let notify: (() => void) | undefined;
    const wake = (): void => notify?.();
    const runs = this.#webTabSubscribers.get(surface) ?? new Map<string, Set<() => void>>();
    const subscribers = runs.get(runId) ?? new Set<() => void>();
    subscribers.add(wake);
    runs.set(runId, subscribers);
    this.#webTabSubscribers.set(surface, runs);

    try {
      let published: string | undefined;
      while (!signal?.aborted) {
        const snapshot = await this.#webTabSnapshot(surface, runId);
        const encoded = JSON.stringify(snapshot);
        if (encoded !== published) {
          published = encoded;
          yield snapshot;
        }
        await Promise.race([
          new Promise<void>((resolve) => {
            notify = resolve;
          }),
          new Promise<void>((resolve) => setTimeout(resolve, 250)),
        ]);
        notify = undefined;
      }
    } finally {
      subscribers.delete(wake);
      if (subscribers.size === 0) runs.delete(runId);
    }
  }

  /**
   * Closes a web tab's page and forgets the tab.
   *
   * Closing a web tab closes its page: a tab the person closes does not leave
   * a page behind in the Chromium, and the runtime's page set follows the
   * strip. The tab leaves the next snapshot either way — a tab that is still
   * published after it was closed would be a tab the strip cannot get rid of.
   */
  async closeWebTabInSession(
    surface: WebuiBrowserSurface,
    runId: string,
    targetId: string,
  ): Promise<void> {
    const tabs = this.#webTabsOf(surface, runId);
    const target = tabs?.get(targetId);
    if (!target) return;
    tabs?.delete(targetId);
    this.#publishWebTabs(surface, runId);
    await this.#closeTarget(surface, target);
  }

  /**
   * Closes the page a web tab is bound to.
   *
   * The tab names the target it holds, and the target names the page: a tab
   * does not have to know which session opened the page it shows, and the
   * page is closed wherever it is. The page leaves every session's tabs and
   * every session's selection, because a page that is gone cannot be the page
   * anybody is looking at or acting on.
   */
  async closeWebTab(target: WebuiBrowserTargetId): Promise<WebuiBrowserWebTabClose> {
    const surface = target.surface;
    for (const [runId, tabs] of [...this.#webTabs.get(surface) ?? new Map()]) {
      if (!tabs.has(target.targetId)) continue;
      tabs.delete(target.targetId);
      this.#publishWebTabs(surface, runId);
    }
    for (const selections of this.#selected.values()) {
      for (const [runId, selection] of [...selections]) {
        if (selection.target.targetId !== target.targetId) continue;
        selections.delete(runId);
        this.#publishWebTabs(surface, runId);
      }
    }
    await this.#closeTarget(surface, target);
    return { accepted: true, targetId: target.targetId };
  }

  /** Closes one page and forgets the target behind it. */
  async #closeTarget(
    surface: WebuiBrowserSurface,
    target: WebuiBrowserTargetId,
  ): Promise<void> {
    const provider = this.#providers.get(surface);
    if (!provider) return;
    // The stream stops first: a screencast left running for a page that is
    // gone is a resource the browser holds for nobody.
    await provider.stopImageStream(target.targetId).catch(() => undefined);
    try {
      await provider.sendCommand(target, "Target.closeTarget", {
        targetId: target.targetId,
      });
    } catch {
      // A page that is already gone needs no closing, and a provider that
      // refuses the command has already done what was asked.
    }
  }

  /**
   * The surface one run is working on, or `undefined` when it has selected
   * nothing anywhere.
   *
   * The Agent's tool context carries no surface, so this is where a tool call
   * learns which browser it is allowed to touch. The answer is derived from the
   * run's own selections — the same state the panel wrote when the person picked
   * a target — rather than from a default the tool path invented, so a run that
   * has selected a target on `edge` acts on `edge` and one that has selected
   * nowhere is refused instead of being handed a browser nobody chose.
   *
   * A run that has selected on more than one surface is working on the one it
   * chose last: that is the surface the person moved to, and the older selection
   * stays as it is for that surface until the run chooses again or its target
   * goes stale.
   *
   * Switching the isolated surface off stops its provider, which forgets that
   * surface's selections, so a run whose own browser was switched off is
   * reported as having selected nowhere. A bridged surface keeps its selection —
   * its provider is deliberately not cached, so there is nothing to tear down —
   * and the call that follows is refused by the authorization gate instead,
   * which names the switch rather than the selection. Either way no browser is
   * driven.
   */
  selectionSurfaceOf(runId: string): WebuiBrowserSurface | undefined {
    let newest: { readonly surface: WebuiBrowserSurface; readonly order: number } | undefined;
    for (const [surface, runs] of this.#selected) {
      const selection = runs.get(runId);
      if (!selection) continue;
      if (!newest || selection.order > newest.order) {
        newest = { surface, order: selection.order };
      }
    }
    return newest?.surface;
  }

  /** The current authorization, normalised so a missing key is off. */
  async readAuthorization(): Promise<WebuiBrowserAuthorization> {
    return normalizeBrowserAuthorization(await this.#options.authorization.read());
  }

  /**
   * Writes one switch and applies the consequence.
   *
   * Turning a surface off stops its provider and forgets its targets; turning
   * it on starts the provider so the surface is usable immediately, without a
   * second confirmation and without waiting for the next request to pay for
   * the launch.
   */
  async writeAuthorization(
    input: Partial<WebuiBrowserAuthorization>,
  ): Promise<WebuiBrowserAuthorization> {
    const written = normalizeBrowserAuthorization(
      await this.#options.authorization.write(input),
    );
    await this.#applyAuthorization(written);
    return written;
  }

  /**
   * Applies the persisted authorization to the bridge.
   *
   * The bridge must start in the state the switches say, not in a state of its
   * own choosing: a pairing that is on while the switch is off would admit an
   * extension the person never authorized.
   */
  async initialize(): Promise<void> {
    const authorization = await this.readAuthorization();
    await this.#applyBridgeAuthorization(authorization, { restore: true });
    await this.#applyIsolatedAuthorization(authorization);
  }

  /**
   * Turns a surface's pairing on or off to match the switch.
   *
   * Each surface is handled on its own: turning Edge on must not enable
   * Chrome, and turning one off must leave the other alone.
   */
  async #applyBridgeAuthorization(
    authorization: WebuiBrowserAuthorization,
    options: { readonly restore?: boolean } = {},
  ): Promise<void> {
    const bridge = this.#options.bridge;
    if (!bridge) return;
    for (const surface of ["edge", "chrome"] as const) {
      const wanted = authorization[surface];
      const current = this.#bridgeSurfaces.get(surface) ?? false;
      if (wanted === current && !options.restore) continue;
      try {
        if (wanted) {
          // At startup the credential is restored, not rotated: the extension
          // still holds the one that was saved, and a fresh secret would leave
          // the two unable to prove possession of the same thing.
          if (options.restore && bridge.restoreSurface) {
            await bridge.restoreSurface(surface);
          } else {
            await bridge.enableSurface?.(surface);
          }
        } else {
          await bridge.disableSurface?.(surface);
        }
        this.#bridgeSurfaces.set(surface, wanted);
      } catch {
        // A surface whose credential store cannot be reached stays off, and the
        // bridge reports that through its own snapshot. Failing the whole
        // authorization write would leave the switches and the pairings
        // disagreeing in a way the person cannot see.
      }
    }
  }

  async #applyAuthorization(authorization: WebuiBrowserAuthorization): Promise<void> {
    await this.#applyBridgeAuthorization(authorization);
    await this.#applyIsolatedAuthorization(authorization);
  }

  /** Applies the authorization to the isolated Chromium. */
  async #applyIsolatedAuthorization(
    authorization: WebuiBrowserAuthorization,
  ): Promise<void> {
    for (const surface of ["isolated-chromium", "edge", "chrome"] as const) {
      const usable = isBrowserSurfaceUsable(authorization, surface);
      const provider = this.#providers.get(surface);
      if (!usable && provider) {
        await this.#stopProvider(surface, provider);
      }
      if (usable && surface === "isolated-chromium" && !provider) {
        // Starting eagerly is what makes "turn it on and it works" true. A
        // failure here is not fatal: the surface stays unauthorized-but-on, and
        // the next list request reports the provider failure with its own code.
        try {
          await this.#ensureProvider(surface);
        } catch {
          // Reported by the call that needs the provider.
        }
      }
    }
  }

  async #ensureProvider(
    surface: WebuiBrowserSurface,
  ): Promise<WebuiBrowserSurfaceProvider | undefined> {
    const existing = this.#providers.get(surface);
    if (existing) return existing;
    if (surface !== "isolated-chromium") {
      // The external surfaces are reached through the bridge, which the server
      // owns. The bridge lends the service a provider for the session that is
      // currently connected; there is none when the extension has not paired.
      //
      // The provider is deliberately NOT cached: the extension's worker may be
      // terminated and restarted, and a cached provider would keep addressing
      // the session that went away.
      if (!this.#options.createBridgeProvider) return undefined;
      const provider = (await this.#options.createBridgeProvider(surface)) ?? undefined;
      if (!provider) return undefined;
      // The external provider learns a target's new generation from the
      // extension's announcements. The registry has to hear about it, or a
      // target that navigated would keep offering the generation the person
      // was looking at before the navigation — and the input recorded against
      // it would look current when it is not.
      provider.onTargetChanged?.((change) => {
        this.#registry.raiseGeneration({
          surface,
          browserId: provider.browserId,
          targetId: change.targetId,
        });
      });
      return provider;
    }
    const create =
      this.#options.createIsolatedProvider ??
      ((options: { readonly dataDir: string; readonly chromePath?: string }) =>
        WebuiIsolatedChromiumProvider.launch(options));
    const provider = await create({
      dataDir: this.#options.dataDir,
      ...(this.#options.chromePath ? { chromePath: this.#options.chromePath } : {}),
    });
    this.#providers.set(surface, provider);
    // The provider is the only party that knows when the page behind a target
    // is replaced. The registry has to hear about it, or an input recorded
    // against the previous page would still look current and would be
    // delivered to the page that replaced it.
    provider.onTargetChanged?.((change) => {
      const raised = this.#registry.raiseGeneration({
        surface,
        browserId: provider.browserId,
        targetId: change.targetId,
      });
      // The panel follows the *tab*, and a navigation replaces the page behind
      // the tab rather than changing which tab is shown. Every run that has
      // selected this tab therefore moves to the new generation: otherwise a
      // run's tools would refuse its own page as stale, and a frame from the
      // previous page would still look current to that run's stream. The order
      // is carried over because a navigation is not the run choosing a
      // different surface.
      if (raised) this.#followGeneration(raised);
      // The page behind a web tab was replaced, so the tab's generation moved
      // and the snapshot that publishes it is no longer the one the client
      // holds. Every session that has the tab open has to hear about it.
      for (const [runId, tabs] of [...(this.#webTabs.get(surface) ?? new Map())]) {
        if (!tabs.has(change.targetId)) continue;
        const tab = tabs.get(change.targetId);
        if (tab && raised) tabs.set(change.targetId, raised.id);
        this.#publishWebTabs(surface, runId);
      }
    });
    provider.onTargetCreated?.(({ target, openerTargetId }) => {
      const identity = this.#registry.observe({
        surface: target.surface,
        browserId: target.browserId,
        targetId: target.targetId,
        title: "",
        url: "",
        status: "open",
        generation: target.generation,
      });
      if (!openerTargetId) return;

      // A person can open a new tab by clicking a link. Keep it in the same
      // session tab strip as the page that opened it, so the UI can select and
      // subscribe to that page. Do not move the Agent's selection: opening a
      // person tab must not steal the page the Agent is working on.
      for (const [runId, tabs] of [...(this.#webTabs.get(surface) ?? new Map())]) {
        if (tabs.has(openerTargetId)) this.#recordWebTab(surface, runId, identity.id);
      }
    });
    return provider;
  }

  async #stopProvider(
    surface: WebuiBrowserSurface,
    provider: WebuiBrowserSurfaceProvider,
  ): Promise<void> {
    this.#providers.delete(surface);
    this.#selected.delete(surface);
    this.#frameSubscribers.delete(surface);
    this.#webTabs.delete(surface);
    this.#webTabSubscribers.delete(surface);
    for (const target of this.#registry.list(surface)) {
      this.#registry.close({
        surface,
        browserId: target.id.browserId,
        targetId: target.id.targetId,
      });
    }
    try {
      await provider.close();
    } catch {
      // A provider that fails to close cleanly must not stop the rest of the
      // teardown.
    }
  }

  /**
   * The provider of an external surface, if one is connected right now.
   *
   * Used by the bridge wiring to hand the service a provider for the live
   * extension session.
   */
  async bridgeProvider(
    surface: "edge" | "chrome",
  ): Promise<WebuiBrowserSurfaceProvider | undefined> {
    return await this.#ensureProvider(surface);
  }

  /** Every target of one surface, as the run sees them. */
  async listTargets(
    surface: WebuiBrowserSurface,
    runId: string = WEBUI_BROWSER_NO_RUN_ID,
  ): Promise<WebuiBrowserTargetList> {
    const authorization = await this.readAuthorization();
    if (!isBrowserSurfaceUsable(authorization, surface)) {
      throw browserOperationError(
        "browser_surface_not_authorized",
        `Browser surface "${surface}" is not authorized.`,
      );
    }
    const provider = await this.#ensureProvider(surface);
    if (!provider) {
      throw browserOperationError(
        "browser_provider_unavailable",
        `Browser surface "${surface}" has no connected browser.`,
        true,
      );
    }
    // This run's own selection, and only that one: marking the flag from a
    // different run's selection is how the panel ends up showing one page while
    // the Agent drives another.
    const states: WebuiBrowserTargetState[] = [];
    for (const target of await provider.listTargets()) {
      const identity = this.#registry.observe({
        surface: target.id.surface,
        browserId: target.id.browserId,
        targetId: target.id.targetId,
        title: target.title,
        url: target.url,
        status: target.status,
        generation: target.id.generation,
      });
      // The provider's generation is the authority on which page is there
      // now, and a selection follows the page it names.
      this.#followGeneration(identity);
      // The selection is read here, per target, rather than once before the
      // listing. The generation can move while the listing is in flight — a
      // page that is still loading is observed as a replaced page — and a
      // selection read before the listing would be compared against a
      // generation that has already moved on, and the tab would be reported
      // as not selected.
      const selected = this.#selectionOf(surface, runId);
      states.push({
        ...identity,
        selected: selected ? isSameWebuiBrowserTarget(selected, identity.id) : false,
      });
    }
    return { surface, targets: states };
  }

  /** Selects the target one run shows on a surface. */
  async selectTarget(
    target: WebuiBrowserTargetId,
    runId: string = WEBUI_BROWSER_NO_RUN_ID,
  ): Promise<WebuiBrowserTargetState> {
    const authorization = await this.readAuthorization();
    if (!isBrowserSurfaceUsable(authorization, target.surface)) {
      throw browserOperationError(
        "browser_surface_not_authorized",
        `Browser surface "${target.surface}" is not authorized.`,
      );
    }
    const known = this.#registry.resolve(target);
    if (!known) {
      throw browserOperationError(
        "browser_target_unknown",
        "The browser target does not exist.",
      );
    }
    if (!this.#registry.isCurrent(target)) {
      throw browserOperationError(
        "browser_target_stale",
        "The browser target has been replaced; select it again.",
      );
    }
    // The registry's generation is the current one, and it is the one the
    // selection is written with. A page that is still loading is observed as
    // a replaced page when its first load lands, and that observation may have
    // arrived before this call did — a selection written from the caller's
    // identity alone would be born stale.
    this.#runSelections(target.surface).set(runId, {
      target: known.id,
      order: (this.#selectionOrder += 1),
    });
    // The snapshot says which web tab is the run's selection, so a selection
    // that moved is a change the subscribers have to hear about.
    this.#publishWebTabs(target.surface, runId);
    return { ...known, selected: true };
  }

  /**
   * Forwards one validated input command.
   *
   * The command is validated before the target is checked, so a malformed
   * command is reported as malformed even when its target is also wrong: the
   * two are different mistakes and a caller that fixed only one would be sent
   * round again.
   *
   * The run id is carried so the caller and the service agree on *whose* input
   * this is, but it deliberately does not fence the delivery: the command names
   * its own target, and a fence here would race the panel's own selection write
   * — a click that lands while the previous `selectBrowserTarget` is still in
   * flight would be refused for aiming at the page the person is looking at.
   * The fence that matters is the registry's: a target that has moved on is
   * refused.
   */
  async sendInput(
    command: WebuiBrowserInputCommand,
    _runId: string = WEBUI_BROWSER_NO_RUN_ID,
  ): Promise<{ readonly accepted: true }> {
    const validated = validateBrowserInputCommand(command);
    const { surface, browserId, targetId } = validated.target;
    const key = `${surface}:${browserId}:${targetId}`;
    const previous = this.#inputQueues.get(key) ?? Promise.resolve();
    const delivery = previous.then(async () => {
      const authorization = await this.readAuthorization();
      if (!isBrowserSurfaceUsable(authorization, surface)) {
        throw browserOperationError(
          "browser_surface_not_authorized",
          `Browser surface "${surface}" is not authorized.`,
        );
      }
      if (!this.#registry.isCurrent(validated.target)) {
        throw browserOperationError(
          "browser_target_stale",
          "The browser target has been replaced; the input was not delivered.",
        );
      }
      const provider = await this.#ensureProvider(surface);
      if (!provider) {
        throw browserOperationError(
          "browser_provider_unavailable",
          `Browser surface "${surface}" has no connected browser.`,
          true,
        );
      }
      await provider.sendInput(validated);
    });
    // A failed operation must not poison the queue behind it. Preserve its error
    // for the caller, while storing a settled continuation for the next event.
    const settled = delivery.then(() => undefined, () => undefined);
    this.#inputQueues.set(key, settled);
    void settled.then(() => {
      if (this.#inputQueues.get(key) === settled) this.#inputQueues.delete(key);
    });
    await delivery;
    return { accepted: true };
  }

  /**
   * The live image stream of one surface, for one run.
   *
   * The stream is an async iterable so the server frames it the same way it
   * frames the terminal's output: the operation handler drives it and the
   * WebSocket server writes what it yields.
   *
   * It carries the frames of the target *this run* selected. Two runs on one
   * surface watch two streams, and each is fenced against its own run's
   * selection below — so a frame belonging to the other run's target is never
   * delivered, whatever the provider hands the stream.
   *
   * The stream follows the run's selection for as long as it runs: a run may
   * select another tab while this stream is open, and the fence alone would
   * leave the panel on a screencast of a tab the person moved away from. Each
   * pass therefore re-reads the selection and moves the provider-side stream
   * onto whatever it names now.
   */
  async *watchFrames(
    surface: WebuiBrowserSurface,
    target: WebuiBrowserTargetId,
    signal?: AbortSignal,
    viewport?: WebuiBrowserViewport,
  ): AsyncIterable<WebuiBrowserImageFrame> {
    const authorization = await this.readAuthorization();
    if (!isBrowserSurfaceUsable(authorization, surface)) {
      throw browserOperationError(
        "browser_surface_not_authorized",
        `Browser surface "${surface}" is not authorized.`,
      );
    }
    const provider = await this.#ensureProvider(surface);
    if (!provider) {
      throw browserOperationError(
        "browser_provider_unavailable",
        `Browser surface "${surface}" has no connected browser.`,
        true,
      );
    }
    // The target has to be a page this service knows. A stream for a target
    // that does not exist would deliver nothing at all, and a panel waiting
    // for a picture that cannot arrive looks like a panel that is broken.
    if (!this.#registry.resolve(target)) {
      throw browserOperationError(
        "browser_target_unknown",
        "The browser target does not exist.",
      );
    }
    if (!this.#registry.isCurrent(target)) {
      throw browserOperationError(
        "browser_target_stale",
        "The browser target has been replaced; select it again.",
      );
    }
    // The queue keeps the newest frame per target and nothing else.
    //
    // A live stream pushes a frame per visual change, and a client that is
    // slow to read would otherwise accumulate every one of them: a browser
    // window being resized is enough to fill a megabyte of base64 in a
    // second. A frame that is already superseded when it is read is not worth
    // delivering, so the queue holds the latest and drops the rest.
    const queue: WebuiBrowserImageFrame[] = [];
    let notify: (() => void) | undefined;
    const deliver = (frame: WebuiBrowserImageFrame) => {
      // The fence. A frame belongs to the page behind the target the
      // subscriber asked for, and all four identity fields decide it. A frame
      // that names another page — another tab's, or a previous generation of
      // this one — is dropped here rather than queued, so a subscriber never
      // sees a picture of a page it did not ask for, not even briefly.
      if (!this.#frameMatchesTarget(target, frame)) {
        this.#droppedFrames.set(surface, (this.#droppedFrames.get(surface) ?? 0) + 1);
        return;
      }
      const index = queue.findIndex(
        (queued) =>
          queued.target.targetId === frame.target.targetId &&
          queued.target.browserId === frame.target.browserId,
      );
      if (index >= 0) queue[index] = frame;
      else if (queue.length < WEBUI_BROWSER_FRAME_QUEUE_LIMIT) queue.push(frame);
      else queue[queue.length - 1] = frame;
      notify?.();
    };

    // One provider-side screencast per page, shared by that page's
    // subscribers: the provider holds one frame handler per page, so two
    // subscriptions for the same page would otherwise take each other's
    // frames away.
    const targetKey = target.targetId;
    const surfaceSubscribers =
      this.#frameSubscribers.get(surface) ??
      new Map<string, Set<(frame: WebuiBrowserImageFrame) => void>>();
    const subscribers =
      surfaceSubscribers.get(targetKey) ??
      new Set<(frame: WebuiBrowserImageFrame) => void>();
    const first = subscribers.size === 0;
    subscribers.add(deliver);
    surfaceSubscribers.set(targetKey, subscribers);
    this.#frameSubscribers.set(surface, surfaceSubscribers);

    const surfaceHandlers =
      this.#frameHandlers.get(surface) ??
      new Map<string, (frame: WebuiBrowserImageFrame) => void>();
    const handler =
      surfaceHandlers.get(targetKey) ??
      ((frame: WebuiBrowserImageFrame) => {
        const current = this.#frameSubscribers.get(surface)?.get(targetKey);
        if (!current) return;
        for (const subscriber of [...current]) subscriber(frame);
      });
    surfaceHandlers.set(targetKey, handler);
    this.#frameHandlers.set(surface, surfaceHandlers);

    // The window takes the size the panel shows the page at. It is stated on
    // every subscription rather than only on the first: a panel that is
    // resized states a new size, and the page behind the target is the same
    // page whoever looks at it.
    if (viewport) await provider.setViewport?.(targetKey, viewport);
    if (first) await provider.startImageStream(targetKey, handler);
    try {
      while (!signal?.aborted) {
        while (queue.length > 0) {
          const frame = queue.shift();
          if (!frame) continue;
          yield frame;
        }
        await Promise.race([
          new Promise<void>((resolve) => {
            notify = resolve;
          }),
          new Promise<void>((resolve) => setTimeout(resolve, 250)),
        ]);
        notify = undefined;
      }
    } finally {
      subscribers.delete(deliver);
      if (subscribers.size === 0) {
        // Cancelling the stream releases the provider-side resources it held:
        // the screencast is stopped, not merely ignored.
        await provider.stopImageStream(targetKey).catch(() => undefined);
        surfaceSubscribers.delete(targetKey);
        surfaceHandlers.delete(targetKey);
      }
    }
  }

  /**
   * Releases a session's pages.
   *
   * A session's pages are released when the session ends — deleted, archived,
   * or transferred away. The release closes the page, drops the target from
   * the registry, and takes the run's selection with it: a page in the
   * isolated Chromium is a live process with a live target, and a target the
   * registry still offers is a target a command could still be aimed at.
   *
   * The release is keyed on the **session**, not on the operation that ended
   * it, so a session that goes away in any of the three ways leaves the same
   * nothing behind.
   */
  async releaseSession(sessionId: string): Promise<void> {
    for (const [surface, runs] of [...this.#webTabs]) {
      const tabs = runs.get(sessionId);
      if (!tabs) continue;
      for (const target of [...tabs.values()]) {
        await this.#releaseTarget(surface, target);
      }
      runs.delete(sessionId);
    }
    // The run's selection goes with the session: a selection that names a page
    // of a session that no longer exists is a selection nothing can act on.
    for (const selections of this.#selected.values()) {
      selections.delete(sessionId);
    }
  }

  /** Closes one page and forgets its target. */
  async #releaseTarget(
    surface: WebuiBrowserSurface,
    target: WebuiBrowserTargetId,
  ): Promise<void> {
    const provider = this.#providers.get(surface);
    // The stream stops first: a screencast left running for a page that is
    // gone is a resource the browser holds for nobody.
    await provider?.stopImageStream(target.targetId).catch(() => undefined);
    if (provider) {
      try {
        await provider.sendCommand(target, "Target.closeTarget", {
          targetId: target.targetId,
        });
      } catch {
        // A page that is already gone needs no closing.
      }
    }
    this.#registry.forget({
      surface: target.surface,
      browserId: target.browserId,
      targetId: target.targetId,
    });
  }

  /**
   * How many frames this service has dropped on a surface.
   *
   * A frame that names another page is dropped rather than put on screen, and
   * the drop is counted rather than silent: a stream that quietly stops
   * updating and a stream that is dropping frames look identical from the
   * outside.
   */
  droppedFrameCount(surface: WebuiBrowserSurface): number {
    return this.#droppedFrames.get(surface) ?? 0;
  }

  /**
   * Whether a frame still describes the page behind the target.
   *
   * Two things have to hold. The frame has to name the very target the
   * subscriber asked for — all four identity fields, so another tab's frame
   * and a previous generation of this one are both refused. And the page
   * behind that target has to still be the one the frame is a picture of: the
   * registry knows the current generation, and a frame of a page that has
   * been replaced is a picture of something the person has already moved away
   * from.
   */
  #frameMatchesTarget(
    target: WebuiBrowserTargetId,
    frame: WebuiBrowserImageFrame,
  ): boolean {
    if (!isSameWebuiBrowserTarget(target, frame.target)) return false;
    const current = this.#registry.resolve(target);
    return current !== undefined && current.id.generation === frame.target.generation;
  }


  /**
   * Runs one browser command.
   *
   * The gate is the whole point of this method: the surface must be
   * authorized, and the command must be either a restricted browser-tool
   * action or permitted by the Full CDP switch. A command that is neither is
   * refused with `browser_capability_denied` — it is never forwarded on the
   * chance that the provider would accept it.
   */
  async sendCommand(
    surface: WebuiBrowserSurface,
    command: string,
    params: Record<string, unknown> = {},
  ): Promise<{ readonly accepted: true; readonly result?: unknown }> {
    await this.#authorizeCommand(surface, command);
    const provider = await this.#commandProvider(surface);
    // The host path has no run, so it acts on the no-run selection — the one
    // the panel makes when no Agent run is active.
    const target = this.#selectionOf(surface, WEBUI_BROWSER_NO_RUN_ID);
    if (!target) {
      throw browserOperationError(
        "browser_target_unknown",
        `No browser target is selected for the "${surface}" surface.`,
      );
    }
    const result = await provider.sendCommand(target, command, params);
    this.#observeOpenedTarget(command, result, surface, WEBUI_BROWSER_NO_RUN_ID);
    return { accepted: true, result };
  }

  /**
   * Runs one browser command against the target this run selected on the
   * surface.
   *
   * This is the path the Agent's browser tools take. A tool call names an
   * action, not a target: the page the run is looking at is the selected
   * target of the surface, so that is what the command acts on. The run id is
   * therefore not optional here — a tool call always belongs to a run, and a
   * selection belonging to somebody else is not a substitute. A surface where
   * this run has selected nothing is refused rather than given one: defaulting
   * to the first tab would let a run drive a page nobody chose, which is the
   * exact split this service exists to prevent.
   *
   * The resolved target travels back with the result so a caller can say which
   * page it acted on; it is the registry's current view of that target, not a
   * second identity the service keeps.
   */
  /**
   * Opens a page, and says what the new page does to the run's selection.
   *
   * The page is opened the same way whoever opened it: one `open_tab`, one surface
   * switch, one provider. What differs is which cell the new page joins, because
   * the run's selection and the tab the person is looking at are two cells with one
   * writer each (ADR 0022):
   *
   * - `agent` — the page becomes the run's selection. The run asked for it, and a
   *   second `open_tab` moves it to the second page without losing the first. It is
   *   also the bootstrap the tool gate allows: `open_tab` is the one action a run
   *   with no selection may perform, because it is the action that would create the
   *   selection the gate wants. Every other action of a run with no selection is
   *   still refused with `browser_target_unknown`: a run that has selected nothing
   *   is refused rather than handed a page nobody chose.
   * - `person` — the page is recorded as the session's web tab, and joins the run's
   *   selection **only if the run had none at this moment**. That is the one
   *   bootstrap, and it is decided here rather than by the caller: the runtime owns
   *   the selection, so the runtime is the only place that can read it at the moment
   *   the page appears. A run that already has a page keeps it — the person opened a
   *   tab, not the Agent's page.
   *
   * The surface is a fact rather than a choice either party made. The **Agent's**
   * page follows the surface its run selected on, and a run without a selection
   * opens a page in the isolated Chromium. The **person's** page is always in the
   * isolated Chromium: the panel is the isolated browser's view, and the external
   * browsers are driven in the person's own windows — so a person typing a url
   * must not be refused because the Agent happens to be working in Edge.
   *
   * The run is optional because the person may have no run in view: an absent run
   * is the panel's own cell, and the bootstrap applies to it exactly as it applies
   * to a run.
   */
  async openWebTab(
    runId: string = WEBUI_BROWSER_NO_RUN_ID,
    params: Record<string, unknown> = {},
    signal?: AbortSignal,
    opener: WebuiBrowserTabOpener = "agent",
  ): Promise<{
    readonly accepted: true;
    readonly target: WebuiBrowserTargetId;
    readonly result?: unknown;
  }> {
    const surface =
      opener === "person"
        ? "isolated-chromium"
        : (this.selectionSurfaceOf(runId) ?? "isolated-chromium");
    // The switch comes first: a surface that is switched off is refused
    // before anything is attempted, so the refusal names the switch rather
    // than the selection.
    await this.#authorizeCommand(surface, "open_tab");
    const provider = await this.#commandProvider(surface);
    if (!provider.openTab) {
      throw browserOperationError(
        "browser_capability_denied",
        `Browser surface "${surface}" cannot open a tab.`,
      );
    }
    // Whether the run has a selection is read **before** the page is created,
    // and it is read across every surface: the Agent acts on one page, so the
    // bootstrap is about the run and not about a surface. A run working in
    // Edge still has a selection, and a person opening a tab must not take it.
    //
    // The bootstrap is decided at the moment the page is opened, and the page
    // takes a moment to open: a run that selected a page while the person's
    // page was opening must not have its selection taken away by the
    // bootstrap afterwards.
    const runHadNoSelection = this.selectionSurfaceOf(runId) === undefined;
    const identity = (await awaitAbortableCommand(
      provider.openTab(params),
      signal,
    )) as WebuiBrowserTargetId;
    // The new page is known to the registry, and it is the session's web tab.
    this.#registry.observe({
      surface: identity.surface,
      browserId: identity.browserId,
      targetId: identity.targetId,
      title: "",
      url: "",
      status: "open",
      generation: identity.generation,
    });
    this.#recordWebTab(surface, runId, identity);
    // The one bootstrap. A run that opened the page writes its own cell. A
    // person does not: their page joins the run's selection only while the run
    // has none, so a person who opens a tab in a running session never moves the
    // Agent off the page it is working on, and a run with nothing to act on is
    // not a dead end.
    if (opener === "agent" || runHadNoSelection) {
      // The registry's generation is the current one. A page that is still
      // loading is observed as a replaced page when its first load lands, and
      // that observation may have arrived before this answer did — a selection
      // written from the answer alone would be born stale, and the Agent's
      // next action would be refused against a page it had just opened.
      const known = this.#registry.resolve(identity);
      this.#runSelections(surface).set(runId, {
        target: known?.id ?? identity,
        order: (this.#selectionOrder += 1),
      });
    }
    this.#publishWebTabs(surface, runId);
    return { accepted: true, target: identity, result: identity };
  }

  async sendCommandToSelection(
    surface: WebuiBrowserSurface,
    runId: string,
    command: string,
    params: Record<string, unknown> = {},
    signal?: AbortSignal,
  ): Promise<{
    readonly accepted: true;
    readonly target: WebuiBrowserTargetId;
    readonly result?: unknown;
  }> {
    // Authorization and the command gate come first, before the selection is
    // looked at: a surface that is switched off is refused before anything is
    // attempted, so the refusal names the switch rather than the selection.
    await this.#authorizeCommand(surface, command);
    const selected = this.#selectionOf(surface, runId);
    if (!selected) {
      throw browserOperationError(
        "browser_target_unknown",
        "No browser target is selected for this surface.",
      );
    }
    if (!this.#registry.isCurrent(selected)) {
      throw browserOperationError(
        "browser_target_stale",
        "The selected browser target has been replaced; select it again.",
      );
    }
    const provider = await this.#commandProvider(surface);
    const result = await awaitAbortableCommand(
      provider.sendCommand(selected, command, params),
      signal,
    );
    this.#observeOpenedTarget(command, result, surface, runId);
    return {
      accepted: true,
      target: selected,
      result,
    };
  }

  /**
   * Runs one browser command against the page the caller names.
   *
   * This is the path a web tab's toolbar takes. The tab holds exactly one page,
   * so the person pressing back means the page in front of them: resolving a
   * selection instead would answer with whichever page the run or the panel
   * happened to have selected, and a toolbar that reloads a page nobody is
   * looking at is worse than no toolbar.
   *
   * The fences are the ones every command path makes, in the same order: the
   * surface's switch and the command gate first, so a refusal names the switch
   * rather than the page; then the generation, so a reference recorded before a
   * navigation is refused instead of being applied to the page that moved.
   *
   * What it deliberately does **not** do is move a selection. A command that
   * names a page acts on that page and answers; which cell the answer belongs to
   * is the opener's answer to give, and the toolbar's three commands open
   * nothing.
   */
  async sendCommandToTarget(
    surface: WebuiBrowserSurface,
    target: WebuiBrowserTargetId,
    command: string,
    params: Record<string, unknown> = {},
    signal?: AbortSignal,
  ): Promise<{
    readonly accepted: true;
    readonly target: WebuiBrowserTargetId;
    readonly result?: unknown;
  }> {
    await this.#authorizeCommand(surface, command);
    if (!this.#registry.isCurrent(target)) {
      throw browserOperationError(
        "browser_target_stale",
        "The browser page has been replaced; open the tab again.",
      );
    }
    const provider = await this.#commandProvider(surface);
    const result = await awaitAbortableCommand(
      provider.sendCommand(target, command, params),
      signal,
    );
    return {
      accepted: true,
      target,
      result,
    };
  }

  /**
   * Observes a page that a command opened.
   *
   * A command that opened a page answers with that page's identity, and the
   * registry learns about the page from the answer alone. The new target is
   * therefore known before anything asks the provider for its list again, and
   * with the generation the provider gave it rather than a guess.
   *
   * The page also joins the session's web tabs: the runtime owns the record of
   * what the session has open, and the strip renders what the runtime
   * publishes.
   *
   * A command that did not open a page — or a provider whose answer is not an
   * identity — is left alone. The registry is the service's record of what the
   * browser has, and a command that opened nothing has nothing to add to it.
   */
  #observeOpenedTarget(
    command: string,
    result: unknown,
    surface: WebuiBrowserSurface,
    runId: string,
  ): void {
    if (command !== "open_tab") return;
    const identity = readOpenedTargetIdentity(result);
    if (!identity) return;
    this.#registry.observe({
      surface: identity.surface,
      browserId: identity.browserId,
      targetId: identity.targetId,
      // The title and the url are the provider's to report, and it reports
      // them the next time it is asked. What the answer carries is the
      // identity, and that is what the registry needs to know a page exists.
      title: "",
      url: "",
      status: "open",
      generation: identity.generation,
    });
    this.#recordWebTab(surface, runId, identity);
  }

  /**
   * The gate both command paths make: the surface must be authorized, and the
   * command must be a restricted browser-tool action or permitted by Full CDP.
   *
   * Refusing here rather than at the provider is what keeps "you did not switch
   * this on" and "the browser broke" apart, and what keeps a command outside
   * the restricted set from being forwarded on the chance that the provider
   * would accept it.
   */
  async #authorizeCommand(surface: WebuiBrowserSurface, command: string): Promise<void> {
    const authorization = await this.readAuthorization();
    if (!isBrowserSurfaceUsable(authorization, surface)) {
      throw browserOperationError(
        "browser_surface_not_authorized",
        `Browser surface "${surface}" is not authorized.`,
      );
    }
    if (!isBrowserCommandAllowed(authorization, command, WEBUI_BROWSER_RESTRICTED_COMMANDS)) {
      throw browserOperationError(
        "browser_capability_denied",
        `The command "${command}" needs Full CDP access, which is not authorized.`,
      );
    }
  }

  /** The provider that may carry out a command on an authorized surface. */
  async #commandProvider(
    surface: WebuiBrowserSurface,
  ): Promise<WebuiBrowserSurfaceProvider> {
    const provider = await this.#ensureProvider(surface);
    if (!provider) {
      throw browserOperationError(
        "browser_provider_unavailable",
        `Browser surface "${surface}" has no connected browser.`,
        true,
      );
    }
    return provider;
  }

  /** The capability matrix, as the surface can offer it right now. */
  async listCapabilities(): Promise<{
    readonly entries: readonly WebuiBrowserCapabilityEntry[];
  }> {
    const authorization = await this.readAuthorization();
    const entries: WebuiBrowserCapabilityEntry[] = [
      {
        surface: "isolated-chromium",
        bridged: false,
        liveImages: authorization.isolatedChromium,
        input: authorization.isolatedChromium,
        agentTools: authorization.isolatedChromium,
        fullCdpApplies: true,
      },
      {
        surface: "edge",
        bridged: true,
        liveImages: authorization.edge,
        input: authorization.edge,
        agentTools: authorization.edge,
        fullCdpApplies: true,
      },
      {
        surface: "chrome",
        bridged: true,
        liveImages: authorization.chrome,
        input: authorization.chrome,
        agentTools: authorization.chrome,
        fullCdpApplies: true,
      },
    ];
    return { entries };
  }

  /** Releases every provider this service started. */
  async close(): Promise<void> {
    for (const [surface, provider] of [...this.#providers]) {
      await this.#stopProvider(surface, provider);
    }
  }
}

/**
 * Awaits one command, or refuses it when the caller's signal aborts.
 *
 * A command already handed to a provider cannot be recalled, so the honest
 * thing to do on abort is to stop *reporting* it: the caller learns the call was
 * cancelled instead of a result that describes a page it no longer owns. The
 * cancellation keeps the browser vocabulary's own code so the caller can tell
 * "the run was cancelled" from "the command was refused".
 */
async function awaitAbortableCommand(
  call: Promise<unknown>,
  signal?: AbortSignal,
): Promise<unknown> {
  if (!signal) return await call;
  const cancelled = () =>
    browserOperationError(
      "browser_operation_cancelled",
      "The browser command was cancelled before it reported a result.",
    );
  if (signal.aborted) {
    // The call is still in flight; its later failure must not surface as an
    // unhandled rejection next to the refusal the caller is waiting for.
    void call.catch(() => undefined);
    throw cancelled();
  }
  return await new Promise<unknown>((resolve, reject) => {
    const onAbort = () => reject(cancelled());
    signal.addEventListener("abort", onAbort, { once: true });
    call.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

/**
 * Reads the browser error a failed operation reports.
 *
 * The server's error envelope carries a code; a browser failure that reached
 * the envelope as a generic error would lose the distinction between "the
 * surface is off" and "the target moved on".
 */
export function browserErrorCode(error: unknown): string | undefined {
  return error instanceof WebuiBrowserOperationError ? error.code : undefined;
}

/**
 * The identity a command that opened a page answered with.
 *
 * The answer is read rather than assumed. A provider that did not open a page
 * — or a surface that cannot open one at all — answers with something else,
 * and the service must not invent a target out of it.
 */
function readOpenedTargetIdentity(result: unknown): WebuiBrowserTargetId | undefined {
  if (typeof result !== "object" || result === null) return undefined;
  const candidate = result as Record<string, unknown>;
  const { surface, browserId, targetId, generation } = candidate;
  if (
    typeof surface !== "string" ||
    typeof browserId !== "string" ||
    typeof targetId !== "string" ||
    typeof generation !== "number" ||
    !Number.isInteger(generation)
  ) {
    return undefined;
  }
  return { surface: surface as WebuiBrowserSurface, browserId, targetId, generation };
}
