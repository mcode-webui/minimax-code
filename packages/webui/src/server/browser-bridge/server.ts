// The bridge server.
//
// The bridge is a WebSocket server of its own. It does not reuse the WebUI's
// `WebSocketServer` and it never goes through `admitWebSocketUpgrade`: the
// generic path admits a loopback browser page with a per-start bearer token,
// and this socket connects to something that is not a browser page at all. It
// has its own path, its own credentials and its own origin rule, and mixing any
// of the three with the generic path would either widen the page path or
// weaken the bridge.
//
// The layer matrix in `scripts/lib/webui-dependency-rules.mjs` classifies this
// directory as `server`, which may reach `shared` and the runtime port but not
// the runtime implementation. That is why the provider surface below is
// declared here rather than imported from the runtime: the two sides meet
// structurally, through the composition root, without a forbidden edge in
// either direction.
//
// What this object owns:
//   * one `BrowserBridgePairing` per external surface, each with its own
//     credential store entry and its own high-entropy credential — Edge and
//     Chrome never share one, so compromising one browser's pairing does not
//     hand over the other;
//   * one `BrowserBridgeRegistry`, which owns the per-target routing and the
//     per-tab serialization;
//   * one `BrowserBridgeSession` per admitted extension.

import { randomUUID } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer, type WebSocket } from "ws";

import {
  BrowserCore,
  type BrowserCoreSession,
} from "@mavis/browser-core";

import {
  WEBUI_BROWSER_RESTRICTED_COMMANDS,
  WEBUI_BRIDGE_BROWSER_SURFACES,
  type WebuiBrowserErrorCode,
  type WebuiBrowserImageFrame,
  type WebuiBrowserInputCommand,
  type WebuiBrowserTargetState,
  type WebuiBridgeBrowserSurface,
} from "../../shared/contracts/browser.js";
import type {
  WebuiBrowserBridgeImageFrame,
  WebuiBrowserBridgeInstallationKeyView,
  WebuiBrowserBridgeTarget,
} from "../../shared/contracts/browser-bridge.js";
import {
  createPlatformSecureCredentialStore,
  type SecureCredentialStore,
} from "./credential-store.js";
import { admitBrowserBridgeUpgrade, parseExtensionOrigin } from "./admission.js";
import { WebuiBridgeCoreTransport } from "./core-transport.js";
import { BrowserBridgePairing } from "./pairing.js";
import { BrowserBridgeRegistry } from "./registry.js";
import { BrowserBridgeSession } from "./session.js";

/**
 * The frame budget the bridge listens with.
 *
 * Larger than the WebUI's own message budget on purpose: the heaviest frame
 * the bridge carries is a base64 image of a live page, and a screencast frame
 * of a 1280x800 window does not fit in 256 KiB. A frame refused for size would
 * be refused silently — it is an image, not a command the caller can see the
 * rejection of — so the budget is set where an ordinary frame fits easily.
 */
const DEFAULT_BRIDGE_MAX_MESSAGE_BYTES = 8 * 1024 * 1024;

/**
 * The environment variable that lists the extension ids each surface admits.
 *
 * Read as a comma-separated list. An absent, empty or whitespace-only value
 * yields an EMPTY allowlist, and an empty allowlist admits nobody.
 */
const EXTENSION_ID_ENV_BY_SURFACE = {
  edge: "MAVIS_BROWSER_EDGE_EXTENSION_IDS",
  chrome: "MAVIS_BROWSER_CHROME_EXTENSION_IDS",
} as const;

/**
 * The environment variable that lists the **store** extension ids.
 *
 * A packaged host reads these and *not* the development ones: a store build
 * has an identity the store issued, and a development build's id is derived
 * from the directory it was loaded from. Accepting a development id in a
 * packaged host would mean accepting whatever happens to be unpacked on the
 * machine.
 */
const STORE_EXTENSION_ID_ENV_BY_SURFACE = {
  edge: "MAVIS_BROWSER_STORE_EDGE_EXTENSION_IDS",
  chrome: "MAVIS_BROWSER_STORE_CHROME_EXTENSION_IDS",
} as const;

/** The provider shape the runtime's browser service consumes. */
export interface WebuiBridgeSurfaceProvider {
  readonly surface: WebuiBridgeBrowserSurface;
  readonly browserId: string;
  listTargets(): Promise<readonly WebuiBrowserTargetState[]>;
  onTargetChanged?(
    listener: (change: { readonly targetId: string; readonly generation: number }) => void,
  ): () => void;
  startImageStream(
    targetId: string,
    onFrame: (frame: WebuiBrowserImageFrame) => void,
  ): Promise<void>;
  stopImageStream(targetId: string): Promise<void>;
  sendInput(command: WebuiBrowserInputCommand): Promise<void>;
  /**
   * Runs one browser command against a target.
   *
   * The target is named rather than implied: the provider is lent to the
   * runtime, and the runtime is the only party that knows which page the run
   * is looking at.
   */
  sendCommand(
    target: { readonly targetId: string; readonly generation: number },
    command: string,
    params: Record<string, unknown>,
  ): Promise<unknown>;
  close(): Promise<void>;
}

/** The options the bridge server is constructed with. */
export interface BrowserBridgeServerOptions {
  /** The TCP host the HTTP server is bound to. */
  readonly host: string;
  /**
   * Whether the WebUI runs in dev mode. Carried through to
   * `admitBrowserBridgeUpgrade`, which ignores it: both composition roots run
   * with `dev: true`, and a flag that loosened extension admission would hand
   * every Browser Use call to any unpacked extension during a mis-served dev
   * cycle.
   */
  readonly dev: boolean;
  /** The OS secure credential store. Tests inject an in-memory one. */
  readonly credentialStore?: SecureCredentialStore;
  /** Maximum inbound frame size in bytes. */
  readonly maxMessageBytes?: number;
  /** The environment the extension allowlists are read from. */
  readonly env?: Readonly<Record<string, string | undefined>>;
  /**
   * Whether this is a packaged host.
   *
   * A packaged host accepts only the extension identities the **store**
   * issued, and never the development ones. The two are different identities:
   * an unpacked build's id is derived from the directory it was loaded from.
   */
  readonly packaged?: boolean;
}

/**
 * A browser failure that carries the shared error code.
 *
 * `operation-dispatch.ts` reads `error.code` structurally, so this reaches the
 * wire envelope with its code intact. It is deliberately a separate class from
 * the runtime's `WebuiBrowserOperationError`: the layer matrix forbids a
 * `server/` import of the runtime implementation, and claiming to be that type
 * would be a lie about which class this is.
 */
export class WebuiBridgeOperationError extends Error {
  readonly code: WebuiBrowserErrorCode;
  readonly retryable: boolean;

  constructor(code: WebuiBrowserErrorCode, message: string, retryable = false) {
    super(message);
    this.name = "WebuiBridgeOperationError";
    this.code = code;
    this.retryable = retryable;
  }
}

/** What one surface's live session currently looks like. */
interface BridgeSurfaceState {
  /**
   * The surface this session belongs to.
   *
   * `undefined` until the peer has named the browser it runs in: the peer's
   * identity can be admitted on more than one surface, so the surface is
   * settled by the peer's own `hello` and not by the order the pairings
   * happen to be in.
   */
  surface: WebuiBridgeBrowserSurface | undefined;
  readonly session: BrowserBridgeSession;
  /** The instance identity, from the extension's `hello` frame. */
  browserId: string;
  /** Whether the challenge/proof handshake has completed. */
  live: boolean;
  /** The most recent announcement, keyed by tab. */
  readonly targets: Map<string, WebuiBrowserBridgeTarget>;
  /** One listener set per tab being streamed. */
  readonly frameListeners: Map<string, Set<(frame: WebuiBrowserImageFrame) => void>>;
  /**
   * The tab the extension is currently streaming pictures of.
   *
   * The extension captures the tab the person is looking at, and it names the
   * tab in every picture it sends. So the last picture's target is the tab in
   * front — the one tab a picture can be taken of.
   */
  visibleTargetId: string | undefined;
  readonly targetChangeListeners: Set<
    (change: { readonly targetId: string; readonly generation: number }) => void
  >;
  /**
   * The Browser Core session of each tab, keyed by tab.
   *
   * The sessions live on the surface rather than on a provider because a
   * provider is borrowed for one operation and handed back: the browser
   * service asks for a provider per call, and a session that lived on the
   * provider would be rebuilt every time — losing the element map and the
   * retained snapshot on each call, which is exactly what those hold.
   */
  readonly coreSessions: Map<string, BrowserCoreSession>;
}

/** The non-secret per-surface state `snapshot()` reports. */
export interface BrowserBridgeServerSurfaceStatus {
  /** Whether any extension id is configured for this surface. */
  readonly configured: boolean;
  /** Whether the pairing holds a usable credential. */
  readonly enabled: boolean;
  /** Whether an extension of this kind is connected and admitted right now. */
  readonly connected: boolean;
  /** The active credential's key id. Not a secret; safe to surface. */
  readonly keyId?: string;
  /** Why the surface could not be switched on, when it could not be. */
  readonly credentialFailure?: string;
}

/**
 * Reads one surface's extension-id allowlist out of the environment.
 *
 * A missing variable, an empty string and a list of nothing but separators all
 * produce an empty set. That is the difference between "nobody may pair" and
 * "anybody may pair", so the empty case fails closed: an operator who has not
 * configured the allowlist yet gets no browser bridge at all, which is
 * recoverable, rather than an open door onto their own browsing session, which
 * is not.
 */
export function readAllowedExtensionIds(
  surface: WebuiBridgeBrowserSurface,
  env: Readonly<Record<string, string | undefined>>,
  options: { readonly packaged?: boolean } = {},
): ReadonlySet<string> {
  const variable = options.packaged
    ? STORE_EXTENSION_ID_ENV_BY_SURFACE[surface]
    : EXTENSION_ID_ENV_BY_SURFACE[surface];
  const raw = env[variable];
  if (!raw) return new Set<string>();
  const ids = raw
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => entry.length > 0);
  return new Set(ids);
}

export class BrowserBridgeServer {
  /** The bridge's own WebSocket server. Never the WebUI's. */
  readonly server: WebSocketServer;
  readonly pairings: ReadonlyMap<WebuiBridgeBrowserSurface, BrowserBridgePairing>;
  readonly registry: BrowserBridgeRegistry;
  /** Whether this host is a packaged build. See the options. */
  readonly packaged: boolean;

  readonly #host: string;
  readonly #dev: boolean;
  readonly #allowedIds = new Map<WebuiBridgeBrowserSurface, ReadonlySet<string>>();
  /** Per-surface live session state, absent when nothing is connected. */
  readonly #surfaces = new Map<WebuiBridgeBrowserSurface, BridgeSurfaceState>();
  /** Why a surface could not be switched on, when it could not be. */
  readonly #credentialFailures = new Map<WebuiBridgeBrowserSurface, string>();
  #closed = false;

  constructor(options: BrowserBridgeServerOptions) {
    this.#host = options.host;
    this.packaged = options.packaged === true;
    this.#dev = options.dev;
    const credentialStore =
      options.credentialStore ??
      createPlatformSecureCredentialStore({ serviceName: "mavis-webui-browser-bridge" });
    const env = options.env ?? process.env;
    const pairings = new Map<WebuiBridgeBrowserSurface, BrowserBridgePairing>();
    for (const surface of WEBUI_BRIDGE_BROWSER_SURFACES) {
      const allowedExtensionIds = readAllowedExtensionIds(surface, env, {
        packaged: this.packaged,
      });
      this.#allowedIds.set(surface, allowedExtensionIds);
      pairings.set(
        surface,
        new BrowserBridgePairing({
          surface,
          credentialStore,
          allowedExtensionIds,
        }),
      );
    }
    this.pairings = pairings;
    this.registry = new BrowserBridgeRegistry({ pairings });
    this.server = new WebSocketServer({
      noServer: true,
      maxPayload: options.maxMessageBytes ?? DEFAULT_BRIDGE_MAX_MESSAGE_BYTES,
    });
  }

  /**
   * Starts the bridge's WebSocket server.
   *
   * The bridge does **not** switch any surface on. The switches own that: the
   * browser service reads the persisted authorization and enables exactly the
   * surfaces whose switch is on. A bridge that enabled every surface on start
   * would hold credentials and admit extensions for browsers the person had
   * never authorized.
   */
  async start(): Promise<void> {
    // Nothing to enable here: the surfaces follow the switches.
  }

  /**
   * Turns one surface's pairing on and mints its credential.
   *
   * A surface whose credential store cannot be reached is left OFF rather than
   * failing the host's boot: the service must still serve the page and report
   * "this browser cannot pair yet" through `snapshot()`, which is recoverable.
   * Off is the fail-closed branch — an off pairing refuses to issue a
   * challenge, so no extension can prove anything it was not issued.
   */
  async enableSurface(surface: WebuiBridgeBrowserSurface): Promise<void> {
    try {
      await this.registry.enableSurface(surface);
      this.#credentialFailures.delete(surface);
    } catch (error) {
      this.#credentialFailures.set(surface, describe(error));
      throw error;
    }
  }

  /**
   * Turns one surface's pairing off.
   *
   * The credential is revoked, that browser's sessions are closed and the old
   * credential is refused from then on. The other surface is untouched: the
   * two browsers' authorizations are independent.
   */
  async disableSurface(surface: WebuiBridgeBrowserSurface): Promise<void> {
    await this.registry.disableSurface(surface);
    this.#credentialFailures.delete(surface);
  }

  /**
   * Re-adopt the credential this surface already had, at startup.
   *
   * A host that restarts must keep the credential the extension still holds,
   * so the startup path restores rather than rotating.
   */
  async restoreSurface(surface: WebuiBridgeBrowserSurface): Promise<void> {
    try {
      await this.registry.restoreSurface(surface);
      this.#credentialFailures.delete(surface);
    } catch (error) {
      this.#credentialFailures.set(surface, describe(error));
      throw error;
    }
  }

  /**
   * One surface's installation key, for the Settings surface to display.
   *
   * This is the bridge's implementation of the narrow source the installation
   * key operation reads. It answers `undefined` for a surface that has never
   * been switched on — there is no key to copy, and the person is told that
   * rather than handed an empty paste.
   */
async readInstallationKey(
    surface: WebuiBridgeBrowserSurface,
  ): Promise<WebuiBrowserBridgeInstallationKeyView | undefined> {
    const pairing = this.pairings.get(surface);
    if (!pairing) return undefined;
    return pairing.installationKeyForDisplay();
  }

  /**
   * Per-surface state for diagnostics. Carries no credential material.
   */
  snapshot(): {
    readonly surfaces: Readonly<
    Record<WebuiBridgeBrowserSurface, BrowserBridgeServerSurfaceStatus>
  >;
  } {
    const surfaces = {} as Record<WebuiBridgeBrowserSurface, BrowserBridgeServerSurfaceStatus>;
    for (const surface of WEBUI_BRIDGE_BROWSER_SURFACES) {
      const pairing = this.pairings.get(surface);
      const failure = this.#credentialFailures.get(surface);
      surfaces[surface] = {
        configured: (this.#allowedIds.get(surface)?.size ?? 0) > 0,
        enabled: pairing?.enabled ?? false,
        connected: this.#surfaces.get(surface)?.live === true,
        ...(pairing?.enabled && pairing.keyId ? { keyId: pairing.keyId } : {}),
        ...(failure ? { credentialFailure: failure } : {}),
      };
    }
    return { surfaces };
  }

  /**
   * Admit and upgrade one bridge connection.
   *
   * The admission decides; this method does not second-guess it. On a refusal
   * the socket has already been written and destroyed, so the only correct
   * action is to return. On success the bridge's own `handleUpgrade` runs —
   * the WebUI's `WebSocketServer` is never handed this socket.
   */
  handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer): void {
    const rejection = admitBrowserBridgeUpgrade(request, request.url, socket, {
      pairings: this.pairings,
      host: this.#host,
      dev: this.#dev,
    });
    if (rejection) return;
    this.server.handleUpgrade(request, socket, head, (ws) => {
      this.#onConnection(ws, request);
    });
  }

  /**
   * The provider for a surface's live extension session.
   *
   * `undefined` means "no extension of that kind is connected right now". That
   * is a different fact from "that surface is not authorized" and from "that
   * extension was refused", and the two must not be conflated: the caller has
   * to be able to tell "nothing is paired" from "you may not use this surface",
   * because the two need opposite responses — one is a prompt to pair, the
   * other a refusal.
   */
  createProvider(surface: WebuiBridgeBrowserSurface): WebuiBridgeSurfaceProvider | undefined {
    const state = this.#surfaces.get(surface);
    if (!state || !state.live) return undefined;
    return new BridgeProvider(surface, state, this.registry);
  }

  /** Release the sessions and shut the bridge's WebSocket server down. */
  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#surfaces.clear();
    await this.registry.shutdown();
    await new Promise<void>((resolve) => {
      this.server.close(() => resolve());
    });
  }

  /* ---------------------------------------------------------------------- */
  /* Connection lifecycle                                                    */
  /* ---------------------------------------------------------------------- */

  #onConnection(ws: WebSocket, request: IncomingMessage): void {
    const candidates = this.#pairingsFor(request);
    if (candidates.length === 0) {
      // Unreachable while admission and this lookup agree; refusing beats
      // constructing a session with no pairing to authenticate against.
      ws.close(1008, "Forbidden");
      return;
    }
    const session = new BrowserBridgeSession({
      pairings: candidates,
      socket: ws,
      sessionId: `bridge-${randomUUID()}`,
    });
    const state: BridgeSurfaceState = {
      surface: undefined,
      session,
      browserId: "",
      live: false,
      targets: new Map(),
      frameListeners: new Map(),
      visibleTargetId: undefined,
      targetChangeListeners: new Set(),
      coreSessions: new Map(),
    };
    this.#observeHello(ws, state);
    session.on("targets", (announcedBrowserId: string, targets) => {
      this.#onTargets(state, announcedBrowserId, targets);
    });
    session.on("frame", (image) => {
      this.#onFrame(state, image);
    });
    // Registration happens on `ready`, NOT on socket open. `ready` is the
    // session's signal that the challenge/proof handshake completed, so a
    // socket that never proves possession never becomes a live session and is
    // never reachable through `createProvider`.
    session.once("ready", () => {
      // The surface is settled here: the peer's `hello` named the browser it
      // runs in, and the session resolved the pairing from that. A session
      // that reached `ready` always has one — the session refuses the
      // handshake otherwise.
      const surface = session.pairing?.surface;
      if (!surface) {
        state.live = false;
        return;
      }
      // A surface is one browser. The panel and the Agent's tools have one
      // provider per surface, and a second live session would be a browser the
      // host could not address.
      //
      // The **same** browser is not a second browser: a Manifest V3 worker that
      // restarts reconnects, and the new connection has to be able to take
      // over from the old one before the old socket's close has been noticed.
      // A *different* browser instance is refused, rather than being allowed
      // to take the surface away from the one that holds it.
      const existing = this.#surfaces.get(surface);
      if (existing && existing !== state && existing.live && existing.browserId !== state.browserId) {
        session.close({ kind: "surface_busy" });
        state.live = false;
        return;
      }
      state.surface = surface;
      this.#surfaces.set(surface, state);
      state.live = true;
      void this.registry.registerSession(surface, state.browserId, session).catch(() => {
        state.live = false;
      });
    });
    session.once("closed", () => {
      const surface = state.surface;
      if (surface && this.#surfaces.get(surface) === state) this.#surfaces.delete(surface);
    });
  }

  /**
   * The pairings an upgrade's identity is admitted on.
   *
   * Mirrors the loop in `admitBrowserBridgeUpgrade`, which has already run by
   * the time this is called and does not report which pairings matched. The
   * walk is over the same allowlists, so the two agree.
   *
   * More than one can match, and that is not an error: an unpacked build has
   * one identity, and a person who loads it in both Edge and Chrome lists
   * that identity on both surfaces. Which surface the peer is on is settled
   * by the browser the peer names in its `hello`, not by the order the
   * pairings happen to be in — the first match here would put a Chrome
   * browser on the Edge pairing.
   */
  #pairingsFor(request: IncomingMessage): readonly BrowserBridgePairing[] {
    const extensionId = parseExtensionOrigin((request.headers.origin ?? "").toLowerCase());
    if (!extensionId) return [];
    const matches: BrowserBridgePairing[] = [];
    for (const pairing of this.pairings.values()) {
      if (pairing.admitsExtensionId(extensionId)) matches.push(pairing);
    }
    return matches;
  }

  /**
   * Capture the instance identity from the extension's `hello` frame.
   *
   * `BrowserBridgeSession` treats `hello` as informational and does not
   * re-emit it, so the wiring code is the only place that can read the browser
   * instance identity off the wire. The listener removes itself as soon as the
   * identity is known, so it does not stay attached for the session's life.
   */
  #observeHello(ws: WebSocket, state: BridgeSurfaceState): void {
    const onMessage = (data: unknown): void => {
      let parsed: { readonly kind?: unknown; readonly browserId?: unknown };
      try {
        parsed = JSON.parse(toText(data)) as typeof parsed;
      } catch {
        // A frame that is not JSON is the session's problem to report, not this
        // observer's; it stays attached until a readable frame arrives.
        return;
      }
      if (parsed.kind !== "hello") return;
      if (typeof parsed.browserId === "string" && parsed.browserId.length > 0) {
        state.browserId = parsed.browserId;
      }
      ws.off("message", onMessage);
    };
    ws.on("message", onMessage);
  }

  #onTargets(
    state: BridgeSurfaceState,
    announcedBrowserId: string,
    targets: readonly WebuiBrowserBridgeTarget[],
  ): void {
    if (state.browserId.length === 0 && announcedBrowserId.length > 0) {
      state.browserId = announcedBrowserId;
    }
    for (const target of targets) {
      const previous = state.targets.get(target.targetId);
      // A lower generation is a late duplicate of an announcement the extension
      // has already moved past; letting it through would roll the target back
      // to a page that no longer exists.
      if (previous && previous.generation > target.generation) continue;
      state.targets.set(target.targetId, target);
      if (previous && previous.generation < target.generation) {
        // The extension raises a tab's generation when the document behind it
        // is replaced, and the bridge carries no DevTools events — so this
        // announcement is how the Browser Core learns that the page it was
        // looking at is gone. The core's references into the previous document
        // must stop being usable at that moment, and this is the call that
        // makes them stop.
        state.coreSessions
          .get(target.targetId)
          ?.synchronizeGeneration(target.generation);
        for (const listener of [...state.targetChangeListeners]) {
          listener({ targetId: target.targetId, generation: target.generation });
        }
      }
    }
  }

  #onFrame(state: BridgeSurfaceState, image: WebuiBrowserBridgeImageFrame): void {
    // The picture names the tab it was taken of, and the extension takes
    // pictures of the tab the person is looking at. So this is the tab in
    // front, whether or not anybody here is listening for it — and it is what
    // a screenshot of this surface can be taken of.
    state.visibleTargetId = image.targetId;
    const listeners = state.frameListeners.get(image.targetId);
    if (!listeners || listeners.size === 0) return;
    // The frame keeps the generation it carries. It is NOT relabelled with the
    // announcement's generation: a frame that was produced for the previous
    // page would then be presented as the current one, and the service's
    // selection fence — which compares the whole identity — would let it
    // through. A frame whose generation does not match the announcement is
    // dropped instead.
    const announced = state.targets.get(image.targetId);
    if (announced && announced.generation !== image.generation) return;
    // A frame can only arrive after the handshake, and the handshake is what
    // settles the surface. A frame without one is dropped rather than
    // presented under an identity nobody can check.
    const surface = state.surface;
    if (!surface) return;
    const frame: WebuiBrowserImageFrame = {
      target: {
        surface,
        browserId: state.browserId || image.browserId,
        targetId: image.targetId,
        generation: image.generation,
      },
      data: image.data,
      format: image.format,
      sequence: image.sequence,
    };
    for (const listener of [...listeners]) listener(frame);
  }
}

/**
 * The provider handed to the runtime's browser service.
 *
 * One thin object per surface, bound to the session that was live when it was
 * borrowed. The browser service deliberately does not cache the provider for a
 * bridged surface — the extension's worker can be terminated and restarted —
 * so a provider always describes the session that was live at the moment it
 * was asked for.
 */
class BridgeProvider implements WebuiBridgeSurfaceProvider {
  readonly surface: WebuiBridgeBrowserSurface;

  readonly #state: BridgeSurfaceState;
  readonly #registry: BrowserBridgeRegistry;
  /**
   * The Browser Core the bridged tabs are driven through.
   *
   * The core is provider-neutral: it owns the action set, the element
   * references, the retained snapshots and the action deadlines, and the
   * bridge supplies only the transport. The action set it is given is the
   * restricted command set, so the core refuses an action the set does not
   * contain rather than the provider refusing it in a second place.
   */
  readonly #core: BrowserCore<string>;
  /** The callback this provider installed per streamed target. */
  readonly #streamed = new Map<string, (frame: WebuiBrowserImageFrame) => void>();

  constructor(
    surface: WebuiBridgeBrowserSurface,
    state: BridgeSurfaceState,
    registry: BrowserBridgeRegistry,
  ) {
    this.#state = state;
    this.#registry = registry;
    this.surface = surface;
    this.#core = new BrowserCore({
      provider: `webui-bridge-${surface}`,
      version: 1,
      actions: WEBUI_BROWSER_RESTRICTED_COMMANDS,
    });
  }

  /**
   * A getter, not a field: the instance identity only becomes known when the
   * extension's `hello` frame arrives, which can be after the provider was
   * borrowed.
   */
  get browserId(): string {
    return this.#state.browserId;
  }

  async listTargets(): Promise<readonly WebuiBrowserTargetState[]> {
    const states: WebuiBrowserTargetState[] = [];
    for (const target of this.#state.targets.values()) {
      states.push({
        id: {
          surface: this.surface,
          browserId: target.browserId || this.#state.browserId,
          targetId: target.targetId,
          generation: target.generation,
        },
        title: target.title,
        url: target.url,
        ...(target.faviconUrl ? { faviconUrl: target.faviconUrl } : {}),
        status: "open",
        // Selection is the browser service's state, not the bridge's: the panel
        // decides which tab it is showing and overwrites this.
        selected: false,
      });
    }
    return states;
  }

  onTargetChanged(
    listener: (change: { readonly targetId: string; readonly generation: number }) => void,
  ): () => void {
    this.#state.targetChangeListeners.add(listener);
    return () => {
      this.#state.targetChangeListeners.delete(listener);
    };
  }

  async startImageStream(
    targetId: string,
    onFrame: (frame: WebuiBrowserImageFrame) => void,
  ): Promise<void> {
    if (!this.#state.targets.has(targetId)) {
      throw new WebuiBridgeOperationError(
        "browser_target_unknown",
        `The ${this.surface} extension announced no such target.`,
      );
    }
    const listeners = this.#state.frameListeners.get(targetId) ?? new Set();
    listeners.add(onFrame);
    this.#state.frameListeners.set(targetId, listeners);
    this.#streamed.set(targetId, onFrame);
  }

  async stopImageStream(targetId: string): Promise<void> {
    const onFrame = this.#streamed.get(targetId);
    if (onFrame) {
      this.#state.frameListeners.get(targetId)?.delete(onFrame);
      this.#streamed.delete(targetId);
    }
    if (this.#state.frameListeners.get(targetId)?.size === 0) {
      this.#state.frameListeners.delete(targetId);
    }
  }

  /**
   * Deliver one validated input command.
   *
   * The routing is NOT re-implemented here: the registry owns which session
   * owns which tab and serializes commands per tab, and it refuses an unknown
   * or stale target rather than guessing. So the dispatch runs FIRST and the
   * registry's own refusal wording is what the caller reads.
   *
   * What this adds is the translation into the shared error code. The code is
   * chosen from facts this provider can already read — the announcement it
   * holds, the generation in it, and the surface the command names — rather
   * than by pattern-matching the registry's messages, which would make this
   * provider break the day a refusal is reworded.
   */
  async sendInput(command: WebuiBrowserInputCommand): Promise<void> {
    const outcome = await this.#registry.dispatch(command);
    if (outcome.kind === "accepted") return;
    if (outcome.kind === "timeout") {
      throw new WebuiBridgeOperationError("browser_operation_timeout", outcome.reason, true);
    }
    throw new WebuiBridgeOperationError(this.#codeForRefused(command), outcome.reason);
  }

  /**
   * The code that matches a registry refusal, read off the facts rather than
   * off the registry's wording.
   */
  #codeForRefused(command: WebuiBrowserInputCommand): WebuiBrowserErrorCode {
    if (command.target.surface !== this.surface) {
      return "browser_command_invalid";
    }
    const announced = this.#state.targets.get(command.target.targetId);
    if (!announced || announced.browserId !== command.target.browserId) {
      return "browser_target_unknown";
    }
    if (announced.generation !== command.target.generation) {
      return "browser_target_stale";
    }
    // The command matches what this surface announced, so the only remaining
    // explanation is that the session which owned the tab is no longer the one
    // registered for it.
    return "browser_target_stale";
  }

  /**
   * Refuse every command.
   *
   * The person's own browser is driven through `chrome.debugger`, which exposes
   * a documented subset of the DevTools domains — not the protocol itself. A
   * provider that forwarded an arbitrary method would either fail opaquely at
   * the extension or, worse, appear to succeed. Refusing explicitly is the
   * only honest answer: the raw DevTools capability belongs to the isolated
   * Chromium this process launches and owns.
   */
  /**
   * Runs one browser command against the extension's browser.
   *
   * A **restricted browser-tool action** is executed by the Browser Core,
   * which owns the semantics the action needs: the element map an `inspect`
   * produced, the retained snapshot a `click`'s reference belongs to, and the
   * generation check that refuses a reference recorded before the document
   * behind the tab was replaced.
   *
   * A **raw DevTools method** is forwarded as-is — the runtime has already
   * decided whether the Full CDP switch allows it, and this class does not
   * keep a second opinion about that.
   *
   * An action the extension cannot perform is refused with a reason. It is not
   * approximated: a click that landed somewhere else would be worse than a
   * refusal.
   */
  async sendCommand(
    target: { readonly targetId: string; readonly generation: number },
    command: string,
    params: Record<string, unknown>,
  ): Promise<unknown> {
    if (command === "open_tab") {
      // The extension's debugger cannot open a page in the person's browser.
      // The refusal names that fact rather than the action's name, because
      // what is missing is the capability and not the request.
      throw new WebuiBridgeOperationError(
        "browser_capability_denied",
        `The ${this.surface} surface cannot open a tab; it is driven through the extension's debugger, which cannot open a page in the person's browser.`,
      );
    }
    if (WEBUI_BROWSER_RESTRICTED_COMMANDS.includes(command as never)) {
      // A restricted action goes through the core. The core's own gate
      // refuses an action it does not implement, and the two refuse it in one
      // place rather than in the provider and the core.
      const session = this.#coreSessionOf(target);
      return await session.execute(command, params);
    }
    const wire = this.#wireCommand(target, command, params);
    if (!wire) {
      throw new WebuiBridgeOperationError(
        "browser_capability_denied",
        `The ${this.surface} surface cannot perform "${command}"; ` +
          "it is driven through the extension's debugger, and this action is not one it performs.",
      );
    }
    const outcome = await this.#registry.dispatchCdp({
      target: {
        surface: this.surface,
        browserId: this.#state.browserId,
        targetId: wire.targetId,
        generation: wire.generation,
      },
      method: wire.method,
      params: wire.params,
    });
    if (outcome.kind === "accepted") return outcome.result;
    if (outcome.kind === "timeout") {
      throw new WebuiBridgeOperationError(
        "browser_operation_timeout",
        `The ${this.surface} surface did not answer the command "${command}" in time.`,
      );
    }
    throw new WebuiBridgeOperationError(
      outcome.unsupported ? "browser_capability_denied" : "browser_provider_failed",
      outcome.reason,
    );
  }

  /**
   * The Browser Core session of a tab.
   *
   * One session per tab, and it outlives the provider that borrows it: the
   * browser service asks the bridge for a provider per call, and a session
   * that were rebuilt on each call would lose the element map and the retained
   * snapshot every time — which is what makes a reference act on the element
   * it names.
   *
   * A tab whose generation has moved since the session was created has a
   * session whose references are stale, and the core has been told so when
   * the announcement arrived. The session is still the right one: it holds
   * the core's own record of the tab, and a new session would start with an
   * empty element map — which is the same state, reached by throwing away
   * work the Agent may still be relying on.
   */
  #coreSessionOf(target: { readonly targetId: string; readonly generation: number }): BrowserCoreSession {
    const existing = this.#state.coreSessions.get(target.targetId);
    if (existing) return existing;
    const session = this.#core.createSession(
      new WebuiBridgeCoreTransport(
        {
          run: async (targetId, generation, method, params) =>
            await this.#dispatchCdp({ targetId, generation }, method, params),
        },
        {
          targetId: target.targetId,
          currentGeneration: () =>
            this.#state.targets.get(target.targetId)?.generation ?? target.generation,
        },
      ),
      {
        // The screenshot is the one action the extension cannot take through
        // the debugger, and it does not need to: the extension is already
        // streaming pictures of the tab the person is looking at, and a
        // picture of that tab is exactly what a screenshot of this page is.
        //
        // The seam is what keeps the boundary intact. `Page.captureScreenshot`
        // would capture *any* tab on demand, including the ones the person is
        // not looking at; the stream captures only the one in front. So the
        // screenshot of a tab that is not in front is refused rather than
        // answered with some other tab's picture.
        captureScreenshot: async (_input, context) =>
          await this.#captureVisibleFrame(target.targetId, context.timeoutMs),
      },
    );
    this.#state.coreSessions.set(target.targetId, session);
    return session;
  }

  /**
   * The next picture the extension sends of a tab.
   *
   * The extension streams pictures of the tab in front; one of them is the
   * picture of this tab, if this tab is the one in front. A tab that is not in
   * front produces no picture at all, and the wait ends without one — which
   * is the honest answer, since the only alternative is somebody else's page.
   */
  async #captureVisibleFrame(
    targetId: string,
    timeoutMs: number,
  ): Promise<Record<string, unknown>> {
    const state = this.#state;
    const listeners = state.frameListeners.get(targetId) ?? new Set();
    const frame = await new Promise<WebuiBrowserImageFrame | undefined>((resolve) => {
      let settled = false;
      const finish = (picture: WebuiBrowserImageFrame | undefined): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        clearInterval(watch);
        listeners.delete(listener);
        resolve(picture);
      };
      const listener = (picture: WebuiBrowserImageFrame): void => finish(picture);
      const timer = setTimeout(() => finish(undefined), Math.max(1, timeoutMs));
      // A picture of another tab means this tab is not the one in front, and no
      // picture of it is coming. The wait ends at once rather than running out
      // the whole budget on something that cannot happen.
      const watch = setInterval(() => {
        const visible = state.visibleTargetId;
        if (visible !== undefined && visible !== targetId) finish(undefined);
      }, 20);
      listeners.add(listener);
      state.frameListeners.set(targetId, listeners);
    });
    if (!frame) {
      throw new WebuiBridgeOperationError(
        "browser_capability_denied",
        `The ${this.surface} surface can only picture the tab that is in front, and this tab is not the one being looked at.`,
      );
    }
    return {
      success: true,
      format: frame.format === "jpeg" ? "jpeg" : "png",
      data: frame.data,
      bytes: Math.floor((frame.data.length * 3) / 4),
      ...(frameWidth(frame) ? { width: frameWidth(frame) } : {}),
      ...(frameHeight(frame) ? { height: frameHeight(frame) } : {}),
    };
  }

  /**
   * Dispatches one DevTools command to a target and returns its result.
   *
   * The refusal of a command that did not run comes back as an error here,
   * because every caller of this path is a single action whose failure is the
   * caller's failure.
   */
  async #dispatchCdp(
    target: { readonly targetId: string; readonly generation: number },
    method: string,
    params: Record<string, unknown>,
  ): Promise<unknown> {
    const outcome = await this.#registry.dispatchCdp({
      target: {
        surface: this.surface,
        browserId: this.#state.browserId,
        targetId: target.targetId,
        generation: target.generation,
      },
      method,
      params,
    });
    if (outcome.kind === "accepted") return outcome.result;
    if (outcome.kind === "timeout") {
      throw new WebuiBridgeOperationError(
        "browser_operation_timeout",
        `The ${this.surface} surface did not answer the command "${method}" in time.`,
      );
    }
    throw new WebuiBridgeOperationError(
      outcome.unsupported ? "browser_capability_denied" : "browser_provider_failed",
      outcome.reason,
    );
  }

  /**
   * The DevTools command a browser-tool action maps to.
   *
   * The action names are the ones the restricted set uses; each is mapped to
   * the command that implements it, and an action with no mapping is refused
   * rather than guessed at.
   */
  #wireCommand(
    target: { readonly targetId: string; readonly generation: number },
    command: string,
    params: Record<string, unknown>,
  ):
    | { readonly targetId: string; readonly generation: number; readonly method: string; readonly params: Record<string, unknown> }
    | undefined {
    const base = {
      targetId: target.targetId,
      generation: target.generation,
    };
    switch (command) {
      case "navigate": {
        const url = params.url;
        if (typeof url !== "string" || url.length === 0) return undefined;
        return { ...base, method: "Page.navigate", params: { url } };
      }
      case "reload":
        return { ...base, method: "Page.reload", params: {} };
      case "get_dom":
        return { ...base, method: "DOM.getDocument", params: { depth: -1 } };
      default:
        // Not a browser-tool action: a raw DevTools method, which the runtime
        // has already authorized.
        return { ...base, method: command, params };
    }
  }

  /**
   * A no-op.
   *
   * The bridge owns the session's lifetime, not the provider's. A provider is
   * borrowed for one operation and handed back; tearing down the extension's
   * socket because a caller finished with it would drop a live browser session
   * the panel may still be watching.
   */
  async close(): Promise<void> {}
}

/**
 * The width of a PNG picture, in pixels.
 *
 * A PNG's dimensions live in the IHDR chunk, which starts eight bytes into the
 * file: four bytes of signature, four of chunk length and type, then the
 * width. The picture the extension sends is base64, so it is decoded first.
 *
 * A picture that is not a PNG — the extension can send JPEG — has no width
 * this can read, and the answer is left out rather than guessed.
 */
function frameWidth(frame: WebuiBrowserImageFrame): number | undefined {
  return pngDimension(frame, 16);
}

/** The height of a PNG picture, in pixels. */
function frameHeight(frame: WebuiBrowserImageFrame): number | undefined {
  return pngDimension(frame, 20);
}

/** One dimension of a PNG picture, read from its header. */
function pngDimension(frame: WebuiBrowserImageFrame, offset: number): number | undefined {
  if (frame.format !== "png") return undefined;
  let bytes: Buffer;
  try {
    bytes = Buffer.from(frame.data, "base64");
  } catch {
    return undefined;
  }
  if (bytes.length < offset + 4) return undefined;
  if (!bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return undefined;
  }
  return bytes.readUInt32BE(offset);
}

/**
 * Decode an inbound `ws` payload to text.
 *
 * The bridge's own observer needs only the frame's `kind` and `browserId`, and
 * never retains or logs the payload.
 */
function toText(data: unknown): string {
  if (typeof data === "string") return data;
  if (Buffer.isBuffer(data)) return data.toString("utf8");
  if (Array.isArray(data)) return Buffer.concat(data as Buffer[]).toString("utf8");
  return "";
}

/** Reduce a failure to one safe line. Never includes credential material. */
function describe(error: unknown): string {
  return error instanceof Error ? error.message.split("\n")[0] ?? "unknown error" : String(error);
}
