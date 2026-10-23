// The isolated Chromium provider.
//
// This is the browser the WebUI process launches and owns. It exists so that
// Browser Use has a browser whose lifetime this process controls: the person
// does not have to install anything, configure a debugging port or log in
// anywhere, and the profile is a temporary directory that belongs to this
// host.
//
// It speaks CDP directly over a `ws` WebSocket. There is no typed DevTools
// client in the dependency set, and the commands Browser Use needs are a
// small, well-understood set.
//
// Four behaviours here are not obvious and are the reason this file exists
// rather than a call into an existing provider:
//
//   * **The attachment race.** A capture issued immediately after a navigation
//     fails with `Not attached to an active page (-32000)` because the
//     renderer is still being swapped. Measured on Chrome 152; the same
//     capture issued a moment later succeeds. The provider therefore waits for
//     the page to be attached rather than assuming a command that failed once
//     will keep failing.
//   * **One page per web tab.** A web tab is a page of this browser, and the
//     provider holds one entry per tab: the CDP session it is addressed with,
//     the generation of the page behind it, and the frame handler that asked
//     for its picture. A command, an input and a frame all name a **target**,
//     and the provider resolves the target to the page that carries it.
//   * **The generation follows the main frame, and it follows it per page.** A
//     navigation replaces the page behind one tab, so that tab's generation is
//     raised then — that is what makes an element reference recorded before the
//     navigation stale. The other tabs' pages are untouched, so their
//     generations do not move: a generation is a fact about a page, not about
//     the browser.
//   * **The image stream is a screencast.** `Page.startScreencast` pushes
//     frames as the page changes, which is what the panel needs; polling
//     `Page.captureScreenshot` would be a screenshot, not a live stream.

import { spawn, type ChildProcess } from "node:child_process";
import { access, mkdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";

import {
  BrowserCore,
  type BrowserCoreSession,
  type ClipboardProvider,
  IsolatedClipboardProvider,
} from "@mavis/browser-core";

import type {
  WebuiBrowserImageFrame,
  WebuiBrowserInputCommand,
  WebuiBrowserSurface,
  WebuiBrowserTargetId,
  WebuiBrowserTargetState,
  WebuiBrowserViewport,
} from "../../../shared/contracts/browser.js";
import { WEBUI_BROWSER_RESTRICTED_COMMANDS } from "../../../shared/contracts/browser.js";
import { browserOperationError } from "../errors.js";
import {
  WebuiBrowserCdpConnection,
  type WebuiBrowserCdpEvent,
} from "./cdp-connection.js";
import { WebuiIsolatedChromiumCoreTransport } from "./core-transport.js";

/** How long the browser may take to publish its DevTools endpoint. */
const STARTUP_TIMEOUT_MS = 30_000;
/** How often the endpoint file is polled while the browser starts. */
const STARTUP_POLL_INTERVAL_MS = 100;
/** How long a command is retried while the page is still being attached. */
const ATTACHMENT_RETRY_WINDOW_MS = 3_000;
/** The delay between attachment retries. */
const ATTACHMENT_RETRY_DELAY_MS = 100;
const CDP_MODIFIER_MASK = { alt: 1, ctrl: 2, meta: 4, shift: 8 } as const;

/** The options the provider is launched with. */
export interface WebuiIsolatedChromiumProviderOptions {
  /** The directory this host keeps its state in. The profile lives under it. */
  readonly dataDir: string;
  /** An explicit Chrome executable. Discovered from the platform when absent. */
  readonly chromePath?: string;
  /** The viewport the launched browser uses. */
  readonly viewport?: { readonly width: number; readonly height: number };
}

/**
 * One target's page was replaced.
 *
 * The provider is the only party that knows when the page behind a tab is
 * replaced, so it is the only party that can say so. Whoever holds the target
 * registry needs this to raise the generation, and until it does, an input
 * recorded against the previous page would still look current.
 */
export interface WebuiBrowserTargetChange {
  readonly targetId: string;
  readonly generation: number;
}

/** A page opened by a page the browser provider already drives. */
export interface WebuiBrowserTargetCreated {
  readonly target: WebuiBrowserTargetId;
  readonly openerTargetId?: string;
}

/** The surface every browser provider implements. */
export interface WebuiBrowserSurfaceProvider {
  /**
   * Which surface this provider drives.
   *
   * The isolated Chromium, or one of the external browsers reached through the
   * bridge. The type is the surface rather than the literal it used to be,
   * because the bridge's provider is a provider of exactly this shape and
   * narrowing it would have made the external path unreachable by construction.
   */
  readonly surface: WebuiBrowserSurface;
  /**
   * The identity of this browser instance.
   *
   * It separates two instances of the same surface, so a target identity —
   * and therefore an input — can never be mistaken for one in another
   * browser.
   */
  readonly browserId: string;
  /** Every target this provider knows about. */
  listTargets(): Promise<readonly WebuiBrowserTargetState[]>;
  /**
   * Subscribes to "the page behind this target was replaced".
   *
   * The returned function unsubscribes. A provider that cannot observe the
   * change may omit this member; the registry then relies on the provider's own
   * refusal, which is why the provider checks the generation too.
   */
  onTargetChanged?(
    listener: (change: WebuiBrowserTargetChange) => void,
  ): () => void;
  /** Subscribes to pages opened from another page, such as `target="_blank"`. */
  onTargetCreated?(
    listener: (created: WebuiBrowserTargetCreated) => void,
  ): () => void;
  /** Starts pushing the target's live images to the callback. */
  /** Gives the browser's window the size the panel shows the page at. */
  setViewport?(targetId: string, viewport: WebuiBrowserViewport): Promise<void>;
  startImageStream(
    targetId: string,
    onFrame: (frame: WebuiBrowserImageFrame) => void,
  ): Promise<void>;
  /** Stops the live images and releases what the stream held. */
  stopImageStream(targetId: string): Promise<void>;
  /** Delivers one validated input command to the target. */
  sendInput(command: WebuiBrowserInputCommand): Promise<void>;
  /**
   * Runs one browser command.
   *
   * `command` is either a restricted browser-tool action (`navigate`, `reload`,
   * …) or, when the Full CDP switch is on, a raw DevTools method. The runtime
   * has already decided which kind is allowed; the provider only executes it,
   * and refuses explicitly when it cannot.
   */
  sendCommand(
    target: WebuiBrowserTargetId,
    command: string,
    params: Record<string, unknown>,
  ): Promise<unknown>;
  /**
   * Opens a page and returns its identity.
   *
   * `open_tab` is not aimed at a page — it creates one — so it needs no target
   * to be sent to. That is what makes it the bootstrap: a run with no
   * selection has no page to aim at, and the page it is about to open does not
   * exist yet.
   *
   * A surface that cannot open a page has no such method, and the service
   * refuses with `browser_capability_denied`.
   */
  openTab?(params: Record<string, unknown>): Promise<WebuiBrowserTargetId>;
  /** Releases everything the provider holds. */
  close(): Promise<void>;
}

/**
 * One page the provider drives.
 *
 * A web tab is a page of this browser, so the session and the generation
 * belong to the page rather than to the browser. The generation is raised when
 * the page behind the tab is replaced, and it moves on its own: one tab
 * navigating leaves every other tab's generation where it was.
 */
interface WebuiIsolatedChromiumPage {
  /** The target this page is addressed by. */
  readonly targetId: string;
  /** The CDP session the connection addresses this page with. */
  readonly sessionId: string;
  /** The generation of the page behind the tab. */
  generation: number;
  /** The page URL for which its favicon was last read. */
  faviconUrlFor?: string;
  faviconUrl?: string;
  /** The sequence number of the last frame this page delivered. */
  frameSequence: number;
  /** Whether a subscriber is currently asking for this page's pictures. */
  streaming: boolean;
  /** The subscriber that asked for this page's pictures. */
  frameHandler?: (frame: WebuiBrowserImageFrame) => void;
  /**
   * The Browser Core session that drives this page.
   *
   * One session per page, because the core models a session as a single
   * document: the element map, the retained snapshot and the generation are
   * facts about one page, and a second page in the same browser has its own.
   *
   * The core raises the generation on the same event the provider does — the
   * main frame's navigation — so the page's own accounting and the core's
   * agree about when a reference recorded before the navigation went stale.
   */
  coreSession?: BrowserCoreSession;
  /** The clipboard this page's actions use. One per page, like the session. */
  readonly clipboardProvider: ClipboardProvider;
}

/**
 * The isolated Chromium provider.
 *
 * One instance owns one browser process and the pages inside it.
 */
export class WebuiIsolatedChromiumProvider implements WebuiBrowserSurfaceProvider {
  readonly surface = "isolated-chromium" as const;
  /** The identity of this browser instance. */
  readonly browserId: string;

  readonly #options: WebuiIsolatedChromiumProviderOptions;
  readonly #userDataDir: string;
  /**
   * The Browser Core this provider's pages are driven through.
   *
   * The core is provider-neutral: it owns the action set, the element
   * references, the retained snapshots and the action deadlines, and the
   * provider supplies only the transport. The action set it is given is the
   * restricted command set, so the core refuses an action the set does not
   * contain rather than the provider refusing it in a second place.
   */
  readonly #core: BrowserCore<string>;
  #child: ChildProcess | undefined;
  #connection: WebuiBrowserCdpConnection | undefined;
  /**
   * The pages this provider drives, by target id.
   *
   * One entry per web tab. A target that is not in here is a page this
   * provider has never attached to, so it cannot be driven.
   */
  readonly #pages = new Map<string, WebuiIsolatedChromiumPage>();
  /**
   * The same pages, by the CDP session that addresses them.
   *
   * A CDP event carries the session it belongs to in its envelope, and that
   * session is how an event is matched to the page it is about.
   */
  readonly #pagesBySession = new Map<string, WebuiIsolatedChromiumPage>();
  /** Attach requests already in flight for targets created by the page. */
  readonly #pendingAttachments = new Map<string, Promise<WebuiIsolatedChromiumPage>>();
  /** Attachment failures are returned by listing instead of publishing dead pages. */
  readonly #attachmentErrors = new Map<string, Error>();
  /** Targets that have closed while their attach request was still in flight. */
  readonly #destroyedTargetIds = new Set<string>();
  /** Targets present before discovery was enabled are not newly opened tabs. */
  readonly #targetsBeforeDiscovery = new Set<string>();
  /** The page the browser was launched with. */
  #launchTargetId: string | undefined;
  #unsubscribe: (() => void) | undefined;

  private constructor(options: WebuiIsolatedChromiumProviderOptions) {
    this.#options = options;
    this.#userDataDir = join(options.dataDir, "browser", "isolated-chromium", "profile");
    this.browserId = `isolated-chromium-${randomSuffix()}`;
    this.#core = new BrowserCore({
      provider: "webui-isolated-chromium",
      version: 1,
      actions: WEBUI_BROWSER_RESTRICTED_COMMANDS,
    });
  }

  /**
   * Launches the browser and opens its first page.
   *
   * The profile is a fresh directory under this host's data directory: the
   * browser is isolated from the person's own browser and from any earlier
   * run, and nothing about it outlives the host.
   */
  static async launch(
    options: WebuiIsolatedChromiumProviderOptions,
  ): Promise<WebuiIsolatedChromiumProvider> {
    const provider = new WebuiIsolatedChromiumProvider(options);
    await provider.#start();
    return provider;
  }

  async #start(): Promise<void> {
    const chromePath = await resolveChromePath(this.#options.chromePath);
    await mkdir(this.#userDataDir, { recursive: true, mode: 0o700 });
    const activePortPath = join(this.#userDataDir, "DevToolsActivePort");
    await rm(activePortPath, { force: true });

    const viewport = this.#options.viewport ?? { width: 1280, height: 800 };
    const child = spawn(
      chromePath,
      [
        "--headless=new",
        "--remote-debugging-port=0",
        "--remote-debugging-address=127.0.0.1",
        `--user-data-dir=${this.#userDataDir}`,
        "--no-first-run",
        "--no-default-browser-check",
        "--disable-background-networking",
        "--disable-component-update",
        "--disable-sync",
        "--disable-features=Translate,MediaRouter",
        `--window-size=${viewport.width},${viewport.height}`,
        "about:blank",
      ],
      { stdio: ["ignore", "ignore", "ignore"] },
    );
    this.#child = child;

    let endpoint: string;
    try {
      endpoint = await waitForDevToolsEndpoint(child, activePortPath);
    } catch (error) {
      child.kill("SIGKILL");
      throw error;
    }

    const connection = await WebuiBrowserCdpConnection.connect(endpoint);
    this.#connection = connection;
    this.#unsubscribe = connection.onEvent((event) => this.#onEvent(event));

    const created = await connection.send<{ targetId: string }>("Target.createTarget", {
      url: "about:blank",
    });
    this.#launchTargetId = created.targetId;
    await this.#attachPage(created.targetId);

    // The panel must also be told about pages created by links using
    // `target="_blank"` or `window.open`. Discover only after the launch page
    // is attached, then ignore the initial inventory Chromium reports as part
    // of enabling discovery.
    const initialTargets = await connection.send<{
      targetInfos?: readonly { targetId: string }[];
    }>("Target.getTargets");
    for (const target of initialTargets.targetInfos ?? []) {
      this.#targetsBeforeDiscovery.add(target.targetId);
    }
    await connection.send("Target.setDiscoverTargets", { discover: true });
  }

  /**
   * Attaches to a page and registers it in the per-target map.
   *
   * Every page the provider drives is attached to, and `Page.enable` is sent to
   * every one of them. A page that was never enabled never receives the
   * navigation events that raise its generation, and a generation that never
   * moves is a fence that never fires.
   */
  async #attachPage(targetId: string): Promise<WebuiIsolatedChromiumPage> {
    const existing = this.#pages.get(targetId);
    if (existing) return existing;
    const pending = this.#pendingAttachments.get(targetId);
    if (pending) return await pending;

    const attaching = this.#attachPageOnce(targetId);
    this.#pendingAttachments.set(targetId, attaching);
    try {
      return await attaching;
    } finally {
      if (this.#pendingAttachments.get(targetId) === attaching) {
        this.#pendingAttachments.delete(targetId);
      }
    }
  }

  async #attachPageOnce(targetId: string): Promise<WebuiIsolatedChromiumPage> {
    const connection = this.#connection;
    if (!connection) {
      throw browserOperationError(
        "browser_provider_unavailable",
        "The isolated Chromium is not running.",
        true,
      );
    }
    const attached = await connection.send<{ sessionId: string }>("Target.attachToTarget", {
      targetId,
      flatten: true,
    });
    if (this.#destroyedTargetIds.has(targetId)) {
      await connection.send("Target.detachFromTarget", { sessionId: attached.sessionId });
      throw browserOperationError(
        "browser_target_unknown",
        "The browser page closed before it could be attached.",
      );
    }
    const page: WebuiIsolatedChromiumPage = {
      targetId,
      sessionId: attached.sessionId,
      generation: 1,
      frameSequence: 0,
      streaming: false,
      clipboardProvider: new IsolatedClipboardProvider(),
    };
    this.#pages.set(targetId, page);
    this.#pagesBySession.set(page.sessionId, page);
    try {
      await this.#withAttachmentRetry(() =>
        connection.send("Page.enable", {}, page.sessionId),
      );
      if (this.#destroyedTargetIds.has(targetId)) {
        this.#forgetPage(targetId);
        await connection.send("Target.detachFromTarget", { sessionId: page.sessionId }).catch(() => undefined);
        throw browserOperationError(
          "browser_target_unknown",
          "The browser page closed before it could be attached.",
        );
      }
      // The Browser Core session is created once the page is attached and its
      // `Page` domain is enabled. It is created here rather than lazily at the
      // first action so that the core's own navigation listener is subscribed
      // before the page can navigate: a session created after a navigation
      // would miss the event and would not know that the references it holds
      // are stale.
      page.coreSession = this.#core.createSession(
        new WebuiIsolatedChromiumCoreTransport(connection, {
          sessionId: page.sessionId,
          targetId: page.targetId,
        }),
        { clipboardProvider: page.clipboardProvider },
      );
      return page;
    } catch (error) {
      this.#forgetPage(targetId);
      await connection.send("Target.detachFromTarget", { sessionId: page.sessionId }).catch(() => undefined);
      throw error;
    }
  }

  /** The page a target names, when this provider drives it. */
  #pageOf(targetId: string): WebuiIsolatedChromiumPage | undefined {
    return this.#pages.get(targetId);
  }

  /** The page a CDP session addresses. */
  #pageBySession(sessionId: string | undefined): WebuiIsolatedChromiumPage | undefined {
    if (!sessionId) return undefined;
    return this.#pagesBySession.get(sessionId);
  }

  /**
   * Forgets a page the browser has destroyed.
   *
   * A closed tab does not leave a page behind in the provider's map: the page
   * is gone, and a target that still resolved would let a command be aimed at
   * a page that no longer exists.
   */
  #forgetPage(targetId: string): void {
    const page = this.#pages.get(targetId);
    if (!page) return;
    this.#pages.delete(targetId);
    this.#pagesBySession.delete(page.sessionId);
    if (this.#launchTargetId === targetId) this.#launchTargetId = undefined;
  }

  /**
   * Opens a page, attaches to it and registers it.
   *
   * The new page is a web tab this provider drives: it is commanded, streamed
   * and input into like any other page, and it carries its own generation.
   * The answer names the page that was created — the surface, the browser, the
   * target and the generation the provider's own accounting gives it — so a
   * caller can address the page from it alone.
   */
  async openTab(params: Record<string, unknown> = {}): Promise<WebuiBrowserTargetId> {
    const connection = this.#connection;
    if (!connection) {
      throw browserOperationError(
        "browser_provider_unavailable",
        "The isolated Chromium is not running.",
        true,
      );
    }
    const url = typeof params.url === "string" ? params.url : "about:blank";
    const created = await connection.send<{ targetId: string }>("Target.createTarget", { url });
    const page = await this.#attachPage(created.targetId);
    return {
      surface: this.surface,
      browserId: this.browserId,
      targetId: page.targetId,
      generation: page.generation,
    };
  }

  async listTargets(): Promise<readonly WebuiBrowserTargetState[]> {
    const connection = this.#connection;
    if (!connection) return [];
    const targets = await connection.send<{
      targetInfos?: readonly {
        targetId: string;
        title: string;
        url: string;
        type: string;
      }[];
    }>("Target.getTargets");
    const states: WebuiBrowserTargetState[] = [];
    for (const info of targets.targetInfos ?? []) {
      if (info.type !== "page") continue;
      // A target created from the page (for example, a clicked external link)
      // becomes a usable web tab only after it has its own flattened CDP
      // session and Page domain. Do not publish undiscovered browser pages as
      // controllable targets.
      if (!this.#pages.has(info.targetId)) {
        const attachmentError = this.#attachmentErrors.get(info.targetId);
        if (attachmentError) throw attachmentError;
        continue;
      }
      // The generation is the page's own. A page this provider drives reports
      // the generation it has raised; a page it never attached to has no
      // generation here — and cannot be driven either, so the number is only
      // ever read as the first one.
      const page = this.#pageOf(info.targetId);
      if (page && page.faviconUrlFor !== info.url && /^https?:/u.test(info.url)) {
        try {
          const favicon = await connection.send<{ result?: { value?: unknown } }>(
            "Runtime.evaluate",
            {
              expression: "(() => { if (document.readyState !== 'complete') return ''; const link = document.querySelector('link[rel~=icon]'); return link?.href || new URL('/favicon.ico', location.href).href; })()",
              returnByValue: true,
              awaitPromise: true,
            },
            page.sessionId,
            { timeoutMs: 1_500 },
          );
          if (typeof favicon.result?.value === "string" && /^https?:/u.test(favicon.result.value)) {
            page.faviconUrlFor = info.url;
            page.faviconUrl = favicon.result.value;
          }
        } catch {
          // A page can navigate or close between Target.getTargets and this
          // optional metadata read; its title and URL remain usable meanwhile.
        }
      }
      states.push({
        id: {
          surface: this.surface,
          browserId: this.browserId,
          targetId: info.targetId,
          generation: page?.generation ?? 1,
        },
        title: info.title,
        url: info.url,
        ...(page?.faviconUrl ? { faviconUrl: page.faviconUrl } : {}),
        status: "open",
        selected: info.targetId === this.#launchTargetId,
      });
    }
    return states;
  }

  /**
   * Gives the browser's window the size the panel shows the page at.
   *
   * The window takes the size of the place it is shown in, so the page is
   * drawn at its own size rather than scaled down into a surface of another
   * shape. It is the same device-metrics override the browser's own window
   * uses, and it does not reload the page.
   */
  async setViewport(targetId: string, viewport: WebuiBrowserViewport): Promise<void> {
    const page = this.#pageOf(targetId);
    if (!page) {
      throw browserOperationError(
        "browser_target_unknown",
        "The isolated Chromium has no such target.",
      );
    }
    const connection = this.#connection;
    if (!connection) return;
    await this.#withAttachmentRetry(() =>
      connection.send(
        "Emulation.setDeviceMetricsOverride",
        {
          width: Math.max(1, Math.round(viewport.width)),
          height: Math.max(1, Math.round(viewport.height)),
          deviceScaleFactor: 1,
          mobile: false,
        },
        page.sessionId,
      ),
    );
  }

  async startImageStream(
    targetId: string,
    onFrame: (frame: WebuiBrowserImageFrame) => void,
  ): Promise<void> {
    const page = this.#pageOf(targetId);
    if (!page) {
      throw browserOperationError(
        "browser_target_unknown",
        "The isolated Chromium has no such target.",
      );
    }
    const connection = this.#connection;
    if (!connection) {
      throw browserOperationError(
        "browser_provider_unavailable",
        "The isolated Chromium is not running.",
        true,
      );
    }
    page.frameHandler = onFrame;
    page.streaming = true;
    // Chrome renders the foregrounded tab and throttles the others, so a
    // background page's screencast produces no new frames. The page that is
    // being streamed is therefore the page that is brought to the front — the
    // same thing a browser does when a person switches to a tab.
    await this.#withAttachmentRetry(() =>
      connection.send("Page.bringToFront", {}, page.sessionId),
    );
    await this.#withAttachmentRetry(() =>
      connection.send(
        "Page.startScreencast",
        { format: "jpeg", quality: 70, everyNthFrame: 1 },
        page.sessionId,
      ),
    );
  }

  async stopImageStream(targetId: string): Promise<void> {
    const page = this.#pageOf(targetId);
    if (!page) return;
    page.streaming = false;
    page.frameHandler = undefined;
    const connection = this.#connection;
    if (!connection) return;
    try {
      await connection.send("Page.stopScreencast", {}, page.sessionId);
    } catch {
      // A browser that has already gone cannot be asked to stop; the resources
      // it held are gone with it.
    }
  }

  async sendInput(command: WebuiBrowserInputCommand): Promise<void> {
    const connection = this.#connection;
    if (!connection) {
      throw browserOperationError(
        "browser_provider_unavailable",
        "The isolated Chromium is not running.",
        true,
      );
    }
    if (command.target.browserId !== this.browserId) {
      throw browserOperationError(
        "browser_target_unknown",
        "The isolated Chromium has no such target.",
      );
    }
    // The page is resolved by the target, so an input reaches the tab it names
    // and no other.
    const page = this.#pageOf(command.target.targetId);
    if (!page) {
      throw browserOperationError(
        "browser_target_unknown",
        "The isolated Chromium has no such target.",
      );
    }
    const sessionId = page.sessionId;
    // The provider is the party that knows when the page behind the tab was
    // replaced, so it is the party that refuses an input recorded against the
    // previous page. The registry refuses the same input too, but the registry
    // learns about the replacement from this provider — so the check that
    // actually protects the page has to live here as well. The generation is
    // the page's own, so the fence holds on every page and not only on the
    // one the browser was launched with.
    if (command.target.generation !== page.generation) {
      throw browserOperationError(
        "browser_target_stale",
        "The browser page was replaced; the input was not delivered.",
      );
    }
    switch (command.kind) {
      case "pointer":
        // Input is not retried: after a CDP timeout it is unknown whether the
        // browser acted, and replaying a click or key sequence can duplicate it.
        {
          const base = { x: command.x, y: command.y };
          if (command.action === "move") {
            await connection.send(
              "Input.dispatchMouseEvent",
              { ...base, type: "mouseMoved", button: "none" },
              sessionId,
            );
          } else if (command.action === "scroll") {
            await connection.send("Input.dispatchMouseEvent", {
              ...base,
              type: "mouseWheel",
              deltaX: command.deltaX,
              deltaY: command.deltaY,
              button: "none",
            }, sessionId);
          } else if (command.action === "press" || command.action === "release") {
            await connection.send("Input.dispatchMouseEvent", {
              ...base,
              type: command.action === "press" ? "mousePressed" : "mouseReleased",
              button: command.button,
              clickCount: command.clickCount ?? 1,
            }, sessionId);
          } else {
            await connection.send("Input.dispatchMouseEvent", {
              ...base,
              type: "mousePressed",
              button: command.button,
              clickCount: command.clickCount,
            }, sessionId);
            await connection.send("Input.dispatchMouseEvent", {
              ...base,
              type: "mouseReleased",
              button: command.button,
              clickCount: command.clickCount,
            }, sessionId);
          }
        }
        return;
      case "key": {
        const modifiers = command.modifiers.reduce(
          (mask, modifier) => mask | CDP_MODIFIER_MASK[modifier],
          0,
        );
        const base = {
          key: command.key,
          ...(command.code ? { code: command.code } : {}),
          modifiers,
        };
        await connection.send(
          "Input.dispatchKeyEvent",
          { type: command.text ? "keyDown" : "rawKeyDown", text: command.text ?? "", ...base },
          sessionId,
        );
        await connection.send("Input.dispatchKeyEvent", { type: "keyUp", ...base }, sessionId);
        return;
      }
      case "text":
        await connection.send("Input.insertText", { text: command.text }, sessionId);
        return;
      default: {
        const exhaustive: never = command;
        throw browserOperationError(
          "browser_command_invalid",
          `Unknown browser input command: ${JSON.stringify(exhaustive ?? null)}.`,
        );
      }
    }
  }

  /**
   * Runs one browser command.
   *
   * A restricted action is executed by the Browser Core, which owns the
   * semantics the action needs: the element map an `inspect` produced, the
   * retained snapshot a `click`'s reference belongs to, the generation check
   * that refuses a reference recorded before a navigation, and the action
   * deadlines. The provider supplies the transport and nothing else.
   *
   * `open_tab` is the one action the core does not run: it creates a page
   * rather than acting on one, so it is the provider's to do.
   *
   * A raw DevTools method is forwarded as-is. It reaches this method only
   * when the Full CDP switch is on; the runtime enforces that.
   */
  async sendCommand(
    target: WebuiBrowserTargetId,
    command: string,
    params: Record<string, unknown>,
  ): Promise<unknown> {
    // The command is addressed to a target, and the target is resolved to the
    // page that carries it. A target this provider does not drive is refused
    // rather than sent to the wrong page.
    const page = this.#pageOf(target.targetId);
    if (!page) {
      throw browserOperationError(
        "browser_target_unknown",
        "The isolated Chromium has no such target.",
      );
    }
    const connection = this.#connection;
    if (!connection) {
      throw browserOperationError(
        "browser_provider_unavailable",
        "The isolated Chromium is not running.",
        true,
      );
    }
    if (command === "open_tab") {
      // The answer names the page that was created: the surface, the
      // browser, the target and the generation the provider's own accounting
      // gives it. A caller can address the page from this answer alone.
      return await this.openTab(params);
    }
    if (command === "return_to_previous_tab") {
      // The action is in the restricted set, but it is not an action of the
      // page: it moves between the pages a run has open, and the pages a run
      // has open are the service's record, not the provider's. The provider
      // owns the pages of one browser, while the tabs of a run may span
      // surfaces.
      //
      // The refusal names the fact rather than pretending the page could not
      // do it: the page is fine, and the request is about something the
      // page does not know.
      throw browserOperationError(
        "browser_capability_denied",
        "The isolated Chromium cannot return to a previous tab; a tab belongs to the run that opened it.",
      );
    }
    if (WEBUI_BROWSER_RESTRICTED_COMMANDS.includes(command as never)) {
      // A restricted action goes through the core. The core's own gate refuses
      // an action it does not implement, and the two refuse it in one place
      // rather than in the provider and the core.
      const session = page.coreSession;
      if (!session) {
        throw browserOperationError(
          "browser_provider_unavailable",
          "The isolated Chromium has no such target.",
          true,
        );
      }
      return await this.#runCoreAction(session, command, params);
    }
    // Not a restricted action: a raw DevTools method, which reaches this point
    // only when the Full CDP switch is on. The result is returned rather than
    // discarded: a command whose caller asked for a value — a runtime
    // evaluation, a document snapshot — would otherwise answer with nothing.
    return await this.#withAttachmentRetry(() =>
      connection.send(command, params, page.sessionId),
    );
  }

  /**
   * Runs one action through the Browser Core.
   *
   * The core's errors are the tool's errors: a stale reference, a missing
   * element, an action that timed out. They are raised as they are, because
   * the code they carry is what tells the Agent whether to inspect again, to
   * pick another element or to try something else. Flattening them into one
   * failure would leave the Agent guessing.
   */
  async #runCoreAction(
    session: BrowserCoreSession,
    command: string,
    params: Record<string, unknown>,
  ): Promise<unknown> {
    return await session.execute(command, params);
  }

  async close(): Promise<void> {
    this.#pages.clear();
    this.#pagesBySession.clear();
    this.#launchTargetId = undefined;
    this.#unsubscribe?.();
    this.#unsubscribe = undefined;
    this.#connection?.close();
    this.#connection = undefined;
    this.#child?.kill("SIGKILL");
    this.#child = undefined;
    // The browser was killed a moment ago, and it may still be writing its
    // profile. A removal that races with those writes fails with ENOTEMPTY, so
    // it is retried rather than reported as a failure: the profile is a
    // directory of files the browser owned, and the browser is gone.
    await rm(this.#userDataDir, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 100,
    }).catch(() => undefined);
  }

  readonly #targetChangeListeners = new Set<
    (change: WebuiBrowserTargetChange) => void
  >();
  readonly #targetCreatedListeners = new Set<
    (created: WebuiBrowserTargetCreated) => void
  >();

  /** Subscribes to "the page behind this target was replaced". */
  onTargetChanged(
    listener: (change: WebuiBrowserTargetChange) => void,
  ): () => void {
    this.#targetChangeListeners.add(listener);
    return () => {
      this.#targetChangeListeners.delete(listener);
    };
  }

  onTargetCreated(
    listener: (created: WebuiBrowserTargetCreated) => void,
  ): () => void {
    this.#targetCreatedListeners.add(listener);
    return () => {
      this.#targetCreatedListeners.delete(listener);
    };
  }

  /**
   * Handles one CDP event.
   *
   * Main-frame navigation replaces the page behind the target, screencast
   * frames are the panel's live image, and a target-created event means a
   * page opened another web tab.
   *
   * Page events are matched by the **envelope's** session id — the flattened
   * target session the connection puts on the event. The
   * `event.params.sessionId` a screencast frame carries is the numeric
   * acknowledgement id, and it names no page: two pages' frames carry the same
   * one.
   */
  #onEvent(event: WebuiBrowserCdpEvent): void {
    if (event.method === "Target.targetCreated") {
      const info = event.params.targetInfo as
        | { targetId?: unknown; type?: unknown; openerId?: unknown }
        | undefined;
      const targetId = info?.targetId;
      if (
        info?.type === "page" &&
        typeof targetId === "string" &&
        !this.#targetsBeforeDiscovery.has(targetId)
      ) {
        this.#destroyedTargetIds.delete(targetId);
        this.#attachmentErrors.delete(targetId);
        const openerTargetId = typeof info.openerId === "string" ? info.openerId : undefined;
        void this.#attachPage(targetId)
          .then((page) => this.#announceTargetCreated(page, openerTargetId))
          .catch((error: unknown) => {
            if (this.#destroyedTargetIds.has(targetId)) return;
            this.#attachmentErrors.set(
              targetId,
              error instanceof Error ? error : new Error(String(error)),
            );
          });
      }
      return;
    }
    // A page that is gone is not a page the provider drives any more. The
    // event carries the target's id rather than a session — it is a
    // browser-level event — so the page is found by its id.
    if (
      event.method === "Target.detachedFromTarget" ||
      event.method === "Target.targetDestroyed"
    ) {
      const destroyed = event.params.targetId;
      if (typeof destroyed === "string") {
        this.#destroyedTargetIds.add(destroyed);
        this.#attachmentErrors.delete(destroyed);
        this.#forgetPage(destroyed);
      }
      return;
    }
    const page = this.#pageBySession(event.sessionId);
    if (!page) return;
    if (event.method === "Page.frameNavigated") {
      const frame = event.params.frame as { parentId?: string } | undefined;
      // Only the main frame's navigation replaces the page. A subframe's
      // navigation leaves the page — and every reference recorded against it —
      // intact.
      if (frame && frame.parentId === undefined) {
        // The generation is the page's own, so one page navigating does not
        // move any other page's generation.
        //
        // The core keeps a generation of its own, and it raises that one on
        // the same event: it listens for the navigation through this page's
        // transport. The two counters are therefore moved by the same event
        // but they are not the same number — the core's starts at zero and
        // counts its own invalidations, while this one starts at one and
        // counts the page's. Nothing compares them: the core checks its
        // references against its own counter, and the panel and the target
        // registry check an input against this one. What they must share is
        // the *moment* — a reference has to go stale for the core at the same
        // time the page stops being current for the panel — and they do,
        // because both move on this event.
        page.generation += 1;
        this.#announceTargetChange(page);
      }
      return;
    }
    if (event.method === "Page.screencastFrame" && page.streaming) {
      const data = event.params.data;
      const metadata = event.params.metadata as { deviceWidth?: number } | undefined;
      if (typeof data !== "string") return;
      const sessionId = event.params.sessionId;
      // The ack goes to the **page's** session. A screencast that is never
      // acknowledged stops after a frame or two: Chromium holds the next frame
      // until the previous one is confirmed, so an ack that goes to the
      // browser's connection instead of the page's leaves the page frozen on
      // whatever it first drew.
      void this.#ackScreencastFrame(sessionId, page.sessionId);
      page.frameSequence += 1;
      page.frameHandler?.({
        target: {
          surface: this.surface,
          browserId: this.browserId,
          targetId: page.targetId,
          generation: page.generation,
        },
        data,
        format: "jpeg",
        sequence: page.frameSequence,
      });
      void metadata;
      return;
    }
  }

  #announceTargetCreated(
    page: WebuiIsolatedChromiumPage,
    openerTargetId: string | undefined,
  ): void {
    const created: WebuiBrowserTargetCreated = {
      target: {
        surface: this.surface,
        browserId: this.browserId,
        targetId: page.targetId,
        generation: page.generation,
      },
      ...(openerTargetId ? { openerTargetId } : {}),
    };
    for (const listener of this.#targetCreatedListeners) {
      try {
        listener(created);
      } catch {
        // One subscriber cannot prevent another from learning of the new tab.
      }
    }
  }

  /**
   * Announces that the page behind the target was replaced.
   *
   * The target registry that lives above this provider cannot know about a
   * navigation on its own, so without this announcement an input recorded
   * against the previous page would still look current to it. The
   * announcement names the target, because the replacement happened behind
   * that tab and no other.
   */
  #announceTargetChange(page: WebuiIsolatedChromiumPage): void {
    for (const listener of this.#targetChangeListeners) {
      try {
        listener({ targetId: page.targetId, generation: page.generation });
      } catch {
        // A listener that throws must not take the browser down with it.
      }
    }
  }

  async #ackScreencastFrame(sessionId: unknown, pageSessionId: string): Promise<void> {
    const connection = this.#connection;
    if (!connection || typeof sessionId !== "number") return;
    try {
      await connection.send("Page.screencastFrameAck", { sessionId }, pageSessionId);
    } catch {
      // An ack that fails means the browser stopped the stream; the stream's
      // own teardown reports it.
    }
  }

  /**
   * Runs a command, retrying while the page is not yet attached.
   *
   * The renderer is swapped during a navigation, and a command issued into
   * that window fails with `Not attached to an active page`. The failure is
   * transient and the retry window is bounded, so a genuinely broken page
   * still fails — it just fails with the original error rather than a timeout.
   */
  async #withAttachmentRetry<T>(operation: () => Promise<T>): Promise<T> {
    const deadline = Date.now() + ATTACHMENT_RETRY_WINDOW_MS;
    let lastError: unknown;
    while (Date.now() < deadline) {
      try {
        return await operation();
      } catch (error) {
        lastError = error;
        if (!isAttachmentFailure(error)) throw error;
        await delay(ATTACHMENT_RETRY_DELAY_MS);
      }
    }
    throw lastError instanceof Error
      ? lastError
      : browserOperationError("browser_provider_failed", "The browser page is not attached.");
  }
}

function isAttachmentFailure(error: unknown): boolean {
  return (
    error instanceof Error &&
    typeof error.message === "string" &&
    error.message.includes("Not attached to an active page")
  );
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function randomSuffix(): string {
  return Math.random().toString(36).slice(2, 10);
}

/**
 * Finds a Chrome executable.
 *
 * The platform list is the same one the repository's own headless transport
 * uses, so the isolated browser and the runtime's browser behave the same on
 * a given machine.
 */
async function resolveChromePath(explicit?: string): Promise<string> {
  if (explicit?.trim()) return explicit.trim();
  for (const candidate of defaultChromeCandidates()) {
    try {
      await access(candidate);
      return candidate;
    } catch {
      // Keep looking.
    }
  }
  throw browserOperationError(
    "browser_provider_unavailable",
    "No Chrome executable was found; set browser.chromePath to the browser to use.",
  );
}

function defaultChromeCandidates(): readonly string[] {
  if (process.platform === "darwin") {
    return [
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "/Applications/Chromium.app/Contents/MacOS/Chromium",
      "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
    ];
  }
  if (process.platform === "win32") {
    const programFiles = process.env.PROGRAMFILES ?? "C:\\Program Files";
    const programFilesX86 = process.env["PROGRAMFILES(X86)"] ?? "C:\\Program Files (x86)";
    const localAppData = process.env.LOCALAPPDATA ?? "";
    return [
      join(programFiles, "Google", "Chrome", "Application", "chrome.exe"),
      join(programFilesX86, "Google", "Chrome", "Application", "chrome.exe"),
      join(programFilesX86, "Chromium", "Application", "chrome.exe"),
      join(localAppData, "Google", "Chrome", "Application", "chrome.exe"),
    ];
  }
  return [
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
  ];
}

/**
 * Waits for the browser to publish its DevTools endpoint.
 *
 * The endpoint is read from the `DevToolsActivePort` file the browser writes
 * rather than scraped from its output: the file is the browser's own
 * statement of where it is listening, and it avoids mistaking a log line for
 * an address.
 */
async function waitForDevToolsEndpoint(
  child: ChildProcess,
  activePortPath: string,
  timeoutMs = STARTUP_TIMEOUT_MS,
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw browserOperationError(
        "browser_provider_failed",
        `The browser exited during startup with code ${child.exitCode}.`,
      );
    }
    try {
      const endpoint = parseDevToolsActivePort(await readFile(activePortPath, "utf8"));
      if (endpoint) return endpoint;
    } catch {
      // The browser has not written the file yet.
    }
    await delay(STARTUP_POLL_INTERVAL_MS);
  }
  throw browserOperationError(
    "browser_operation_timeout",
    "The browser did not publish a DevTools endpoint in time.",
    true,
  );
}

function parseDevToolsActivePort(raw: string): string | undefined {
  const [port, path] = raw.trim().split("\n");
  if (!port || !path) return undefined;
  const parsed = Number(port);
  if (!Number.isInteger(parsed) || parsed <= 0) return undefined;
  return `ws://127.0.0.1:${parsed}${path}`;
}
