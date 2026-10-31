// The browser adapter.
//
// The WebUI does not own the browser: the runtime host is on the other side of
// this seam, and this adapter is what binds the two. It reads and writes the
// four authorization switches through the host's configuration capability — so
// the switches survive a restart, which is what "the enabled state survives a
// WebUI restart" requires — and it owns the browser service that holds the
// providers.
//
// The host is attached late. The host is what *takes* the browser provider, so
// the provider has to exist before the host does, while the browser service
// reads its switches *through* the host: the two cannot both be constructed
// first. The store below therefore resolves the host when it is read, which is
// what breaks the cycle, and the composition root attaches the host as soon as
// the assembly hands it back.
//
// When the attached host cannot answer the authorization at all, no port is
// exposed: the browser operations then stay unregistered, which is better than
// an operation that exists and refuses forever, because the surface would offer
// a control the host would never answer.

import type {
  WebuiBrowserAuthorization,
  WebuiBrowserCapabilityEntry,
  WebuiBrowserImageFrame,
  WebuiBrowserInputCommand,
  WebuiBrowserSurface,
  WebuiBrowserTabOpener,
  WebuiBrowserTargetId,
  WebuiBrowserTargetList,
  WebuiBrowserTargetState,
  WebuiBrowserWebTabClose,
  WebuiBrowserWebTabSnapshot,
} from "../../shared/contracts/browser.js";
import {
  WebuiBrowserService,
  type WebuiBrowserAuthorizationStore,
  type WebuiBrowserServiceOptions,
} from "../browser/browser-service.js";
import type { WebuiBrowserSurfaceProvider } from "../browser/isolated-chromium/provider.js";
import { createWebuiBrowserToolAdapter } from "../browser/tool-adapter.js";
import type { WebuiBrowserAdapter } from "../browser-provider.js";
import type { WebuiBrowserPort } from "../port.js";
import type { WebuiRuntimeHostHandle } from "./host-contract.js";
import { requireCliService } from "./requirements.js";

/**
 * The extension bridge the adapter is wired to.
 *
 * Declared structurally rather than imported from
 * `src/server/browser-bridge/server.ts`. The layer matrix classifies
 * `src/runtime/**` as `runtime`, which may reach `shared` and the runtime port
 * but NOT `server/`, and the bridge server lives under `src/server/`. Naming
 * its class here would be a forbidden edge, so the composition root — which
 * sits outside the layer system and is the one place both sides may meet —
 * assembles the bridge and hands it in. Structural typing is what lets the two
 * meet without an import in either direction.
 */
export interface WebuiBrowserBridge {
  /**
   * The provider for a live extension session, or `undefined` when no
   * extension of that kind is connected.
   *
   * The bridge is a server-side object and the runtime may not import it, so
   * the two meet structurally: the composition root hands the bridge in and
   * the adapter reads this member. The member is named after what the bridge
   * exposes, so the two cannot drift apart.
   */
  createProvider(
    surface: "edge" | "chrome",
  ): WebuiBrowserSurfaceProvider | undefined;
  /** Turns a surface's pairing on and mints its credential. */
  enableSurface?(surface: "edge" | "chrome"): Promise<void>;
  /**
   * Re-adopts the credential the surface already had, at startup.
   *
   * A host that restarts must keep the credential the extension still holds,
   * so the startup path restores rather than rotating.
   */
  restoreSurface?(surface: "edge" | "chrome"): Promise<void>;
  /**
   * Turns a surface's pairing off: the credential is revoked, the sessions are
   * closed and the old credential is refused from then on.
   */
  disableSurface?(surface: "edge" | "chrome"): Promise<void>;
}

/**
 * The browser adapter and the handle that releases it.
 *
 * The port and the release travel together because the composition root is
 * the only place that can guarantee the release happens: a browser process
 * that outlived its service would be a browser nobody can switch off.
 */
export interface WebuiBrowserAdapterBinding {
  /**
   * The port the browser operations bind to.
   *
   * Absent until a runtime host that can answer the browser authorization has
   * been attached — and still absent after one that cannot, which is what keeps
   * the browser operations unregistered rather than bound to a port that would
   * refuse every call.
   */
  readonly port: WebuiBrowserPort | undefined;
  /**
   * The Agent's browser tools, over this same service.
   *
   * Both faces of the one browser session live here because they must be the
   * same service: a tool adapter built from anything else would drive a second
   * browser, and the panel would show the first. The composition root hands
   * this member to the runtime host as its browser provider.
   */
  readonly toolAdapter: WebuiBrowserAdapter;
  /**
   * The bridge this adapter was wired to, when one was supplied.
   *
   * Surfaced so a composition root that assembled the bridge reads it back
   * from one place rather than keeping a second reference alongside this one.
   * The bridge's own lifetime belongs to whoever constructed it.
   */
  readonly browserBridge?: WebuiBrowserBridge;
  /**
   * Attaches the runtime host the authorization switches are read through.
   *
   * Called once, by the composition root, right after the runtime host has been
   * created. Attaching decides whether a port exists at all, so it is the first
   * moment at which "this host has no browser surface" can be told apart from
   * "the host is not here yet".
   */
  attachHost(host: WebuiRuntimeHostHandle): void;
  /**
   * Applies the persisted authorization to the bridge.
   *
   * The composition root calls this once, after the adapter is built and
   * before the service starts serving. Until it runs, the bridge's pairings do
   * not know which switches are on.
   */
  initialize(): Promise<void>;
  /**
   * Releases every provider the browser service started.
   */
  close(): Promise<void>;
  /**
   * Releases one session's pages.
   *
   * A session's pages are released when the session ends — deleted, archived
   * or transferred away. The composition root wires this to the port's
   * session-ending operations, so the release is keyed on the session rather
   * than on whichever operation happened to end it.
   */
  releaseSession(sessionId: string): Promise<void>;
}

/** What the adapter needs before it has a host. */
export interface CreateBrowserAdapterOptions {
  /** The directory the isolated browser keeps its profile under. */
  readonly dataDir: string;
  /** Overrides for the service, used by tests to supply a fake provider. */
  readonly overrides?: Partial<WebuiBrowserServiceOptions>;
  /** The extension bridge the service borrows external browsers through. */
  readonly bridge?: WebuiBrowserBridge;
}

/**
 * Builds the browser adapter, before its runtime host exists.
 *
 * `bridge` is what makes the Edge and Chrome surfaces resolve: without it the
 * service has no way to reach them, and `createProvider` answering "nothing is
 * paired" is what keeps "you may not use this surface" distinguishable from
 * "the extension is not connected right now".
 */
export function createBrowserAdapter(
  options: CreateBrowserAdapterOptions,
): WebuiBrowserAdapterBinding {
  let host: WebuiRuntimeHostHandle | undefined;
  let port: WebuiBrowserPort | undefined;
  const bridge = options.bridge;
  const service = new WebuiBrowserService({
    authorization: {
      read: async () => browserAuthorizationStore(host).read(),
      write: async (input) => browserAuthorizationStore(host).write(input),
    },
    dataDir: options.dataDir,
    ...(bridge
      ? {
          // The service asks asynchronously and the bridge answers
          // synchronously; the adapter is where the two meet.
          createBridgeProvider: async (surface: "edge" | "chrome") =>
            bridge.createProvider(surface),
          bridge: {
            enableSurface: bridge.enableSurface?.bind(bridge),
            disableSurface: bridge.disableSurface?.bind(bridge),
            restoreSurface: bridge.restoreSurface?.bind(bridge),
          },
        }
      : {}),
    ...options.overrides,
  });

  return {
    get port() {
      return port;
    },
    toolAdapter: createWebuiBrowserToolAdapter({ browser: service }),
    ...(bridge ? { browserBridge: bridge } : {}),
    attachHost: (next: WebuiRuntimeHostHandle) => {
      host = next;
      // Whether a port exists is decided here and only here: the answer comes
      // with the host, so a host without the browser surface leaves the
      // operations unregistered instead of bound to a port that refuses all.
      port = canAnswerBrowserAuthorization(next)
        ? createBrowserPort(service)
        : undefined;
    },
    initialize: () => service.initialize(),
    close: () => service.close(),
    releaseSession: (sessionId: string) => service.releaseSession(sessionId),
  };
}

/** The port the browser operations bind to. One object per service. */
function createBrowserPort(service: WebuiBrowserService): WebuiBrowserPort {
  return {
    getAuthorization: () => service.readAuthorization(),
    setAuthorization: (input) => service.writeAuthorization(input),
    listTargets: (surface: WebuiBrowserSurface, runId?: string) =>
      service.listTargets(surface, runId),
    selectTarget: (target: WebuiBrowserTargetId, runId?: string) =>
      service.selectTarget(target, runId),
    sendInput: (command: WebuiBrowserInputCommand, runId?: string) =>
      service.sendInput(command, runId),
    sendCommand: (
      surface: WebuiBrowserSurface,
      command: string,
      params?: Record<string, unknown>,
    ) => service.sendCommand(surface, command, params ?? {}),
    sendCommandToSelection: (
      surface: WebuiBrowserSurface,
      runId: string,
      command: string,
      params?: Record<string, unknown>,
    ) => service.sendCommandToSelection(surface, runId, command, params ?? {}),
    sendCommandToTarget: (
      surface: WebuiBrowserSurface,
      target: WebuiBrowserTargetId,
      command: string,
      params?: Record<string, unknown>,
      signal?: AbortSignal,
    ) => service.sendCommandToTarget(surface, target, command, params ?? {}, signal),
    watchFrames: (surface: WebuiBrowserSurface, target: WebuiBrowserTargetId, signal?: AbortSignal) =>
      service.watchFrames(surface, target, signal),
    closeWebTab: (target: WebuiBrowserTargetId) => service.closeWebTab(target),
    // `runId` is optional on the port because the person is not a run: the
    // service reads an absent run as the panel's own cell.
    openWebTab: (
      runId?: string,
      params?: Record<string, unknown>,
      signal?: AbortSignal,
      opener?: WebuiBrowserTabOpener,
    ) => service.openWebTab(runId, params ?? {}, signal, opener),
    watchWebTabs: (surface: WebuiBrowserSurface, runId?: string, signal?: AbortSignal) =>
      service.watchWebTabs(surface, runId, signal),
    listCapabilities: () => service.listCapabilities(),
  };
}

/** Whether a host can answer the browser authorization switches at all. */
function canAnswerBrowserAuthorization(host: WebuiRuntimeHostHandle): boolean {
  const cliService = host.cliService;
  return Boolean(
    cliService?.getBrowserAuthorization && cliService.setBrowserAuthorization,
  );
}

/**
 * The attached host's authorization store.
 *
 * Fails closed rather than answering "nothing is authorized": the switches
 * decide what a browser may do, so a host that cannot report them must stop the
 * call rather than be read as a host that granted nothing — which would report a
 * missing capability as a deliberate refusal.
 */
function browserAuthorizationStore(
  host: WebuiRuntimeHostHandle | undefined,
): WebuiBrowserAuthorizationStore {
  const cliService = host?.cliService;
  const get = cliService?.getBrowserAuthorization;
  const set = cliService?.setBrowserAuthorization;
  if (!cliService || !get || !set) {
    throw new Error("runtime host does not expose the browser authorization");
  }
  return {
    read: () => get.call(cliService),
    write: (input) => set.call(cliService, input),
  };
}

/**
 * The authorization the host reports, when it reports one.
 *
 * Used by the capability manifest to decide whether the browser family is
 * present at all.
 */
export async function readHostBrowserAuthorization(
  host: WebuiRuntimeHostHandle,
): Promise<WebuiBrowserAuthorization | undefined> {
  const cliService = host.cliService;
  if (!cliService?.getBrowserAuthorization) return undefined;
  return await cliService.getBrowserAuthorization();
}

export type {
  WebuiBrowserAuthorization,
  WebuiBrowserCapabilityEntry,
  WebuiBrowserImageFrame,
  WebuiBrowserInputCommand,
  WebuiBrowserSurface,
  WebuiBrowserTargetId,
  WebuiBrowserTargetList,
  WebuiBrowserTargetState,
};
