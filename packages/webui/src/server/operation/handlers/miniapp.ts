// Dedicated handlers: the Mini App surface.
//
// None of the five can be a plain binding. `openMiniApp` shapes its response —
// the client is handed the loopback proxy's URL, never the Mini App's own origin
// or the credential its guard demands — and `stopMiniApp` owns the other half of
// that proxy's lifetime. `listMiniApps` keeps their company rather than becoming a
// lone binding because they answer one capability: a host either has Mini Apps or
// it has none, and the refusal has to be the same message whichever of them is
// asked first. `watchMiniAppPresentation` adds the one thing the runtime cannot
// answer at all: the service's own record of which presentation is live.
//
// One listener per plugin, held in this closure. The proxy's port is derived from
// the plugin id, so a second listener for the same plugin would either fail to
// bind or serve the page from a second origin and silently discard the page's own
// storage. `open` therefore replaces the listener it finds, and `stop` closes it.
//
// One presentation lease per plugin, held in the same closure and for the same
// reason: it describes this service's presentations, not the runtime's state
// (`../../miniapp/presentation-lease.ts`).
import { WebuiCapabilityUnavailableError } from "../../../shared/envelope.js";
import { MINIAPP_CAPABILITY_ABSENT } from "../../../runtime/port.js";
import type { WebuiOperationPort } from "../bind-handlers.js";
import {
  listMiniAppsOperation,
  openMiniAppOperation,
  stopMiniAppOperation,
  watchMiniAppPresentationOperation,
  watchMiniAppPresenterOperation,
} from "../miniapp.js";
import {
  startMiniAppProxy,
  type MiniAppProxy,
  type MiniAppProxyTarget,
} from "../../miniapp/proxy.js";
import {
  createMiniAppProxyRegistry,
  type MiniAppProxyRegistry,
} from "../../miniapp/proxy-registry.js";
import { createMiniAppPresentationLeases } from "../../miniapp/presentation-lease.js";
import {
  createMiniAppAgentConnections,
  type MiniAppAgentConnections,
} from "../../miniapp/agent-connections.js";
import { createMiniAppAgentPanels, type MiniAppAgentPanels } from "../../miniapp/agent-panels.js";
import { createMiniAppAgentRuns, type MiniAppAgentRuns } from "../../miniapp/agent-runs.js";
import { miniAppPageBridge } from "../../miniapp/bridge.js";
import type { MiniAppPresenterView } from "../../miniapp/presenter.js";
import type {
  WebuiMiniAppCatalogue,
  WebuiMiniAppPresentationState,
} from "../../../shared/contracts/miniapp.js";
import type {
  WebuiOperationContext,
  WebuiOperationHandler,
  WebuiOperationRegistryEntry,
  WebuiOperationValidation,
} from "../operation-contract.js";

type BodyOf<Descriptor> = Descriptor extends {
  readonly validate: (body: unknown) => WebuiOperationValidation<infer Body>;
}
  ? Body
  : never;

type DedicatedHandler<Descriptor> = WebuiOperationHandler<BodyOf<Descriptor>, unknown>;

/** The capability as one object, or the refusal that replaces it. */
interface MiniAppCapability {
  readonly list: NonNullable<WebuiOperationPort["listMiniApps"]>;
  readonly open: NonNullable<WebuiOperationPort["openMiniApp"]>;
  readonly stop: NonNullable<WebuiOperationPort["stopMiniApp"]>;
}

/**
 * The capability, or `capability_unavailable`.
 *
 * A host composed without the Mini App cell has no member here at all. Answering
 * that with an empty catalogue would tell the person the feature exists and has
 * nothing in it, which is the one answer that leads nowhere; the refusal names the
 * missing capability and carries the code a client can branch on.
 *
 * A member that is present but not callable counts as absent, because the three
 * are one capability: the runtime's facade composes all of them from the same
 * application cell, so a port with two of them is broken rather than partial, and
 * "this host cannot answer" is the honest thing to say about it.
 */
function requireMiniApps(port: WebuiOperationPort): MiniAppCapability {
  const { listMiniApps, openMiniApp, stopMiniApp } = port;
  if (
    typeof listMiniApps !== "function" ||
    typeof openMiniApp !== "function" ||
    typeof stopMiniApp !== "function"
  )
    throw new WebuiCapabilityUnavailableError(MINIAPP_CAPABILITY_ABSENT);
  // The port members are called with the port as receiver, exactly as
  // `executeBinding` does: a capability that reads `this` must see the object it
  // was taken from, not this wrapper.
  return { list: listMiniApps, open: openMiniApp, stop: stopMiniApp };
}

export interface MiniAppHandlerOptions {
  /** The host-owned presenter whose open/close requests the browser must enact. */
  readonly presenter?: MiniAppPresenterView;
  /**
   * Starts one plugin's loopback listener. Defaults to the real proxy.
   *
   * A test substitutes a wrapper over the real one to observe which target a
   * launch produced and whether the previous listener was closed, without owning
   * the port a plugin's URL is derived from.
   */
  readonly startProxy?: typeof startMiniAppProxy;
  /**
   * The registry those listeners live in.
   *
   * Passed when the host wants them closed at service shutdown — a leaked
   * listener holds a plugin's derived port, so the next start of that Mini App
   * fails to bind. With none, this handler owns a private registry.
   */
  readonly proxies?: MiniAppProxyRegistry;
  /**
   * The presentations this service is serving, shared with the agent handlers.
   *
   * A start records the launch's process generation here and a stop drops it; the
   * page bridge then refuses a call whose generation is not the live one. Passed in
   * rather than created per handler set because both halves must read one record —
   * with none, this handler keeps a private one, which is what a test gets.
   */
  readonly connections?: MiniAppAgentConnections;
  /**
   * The sessions the runtime was told are shown, and the turns this service is
   * following. A stop closes the first and cancels the second before it revokes the
   * generation, because after the revoke neither report can be delivered.
   */
  readonly panels?: MiniAppAgentPanels;
  readonly runs?: MiniAppAgentRuns;
}

/**
 * Whether a lookup failed because the session is not there.
 *
 * The runtime answers a missing session with an `AppError` carrying `status: 404`
 * and `key: "SESSION_NOT_FOUND"`; an adapter on another host could carry the code
 * instead, so both spellings are accepted. Nothing else is — a transport failure,
 * a refused capability or a thrown string says nothing about the session.
 */
function isConfirmedMissingSession(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const { status, key, code } = error as {
    readonly status?: unknown;
    readonly key?: unknown;
    readonly code?: unknown;
  };
  return (
    status === 404 ||
    key === "SESSION_NOT_FOUND" ||
    code === "SESSION_NOT_FOUND" ||
    code === "not_found"
  );
}

export function createMiniAppHandlerEntries(
  port: WebuiOperationPort,
  options: MiniAppHandlerOptions = {},
): ReadonlyMap<string, WebuiOperationRegistryEntry> {
  /**
   * The listeners. A caller that wants them closed on shutdown passes the
   * registry it will close (`service.miniappProxies`); with none, this handler
   * keeps a private one, which is what a test or an embedded host gets.
   */
  const proxies =
    options.proxies ??
    createMiniAppProxyRegistry(options.startProxy ? { start: options.startProxy } : {});
  /**
   * The last call per plugin, so two calls cannot interleave.
   *
   * Run concurrently, a second `open` would find the derived port still bound by
   * the first and fail to bind — and a failed open stops the runtime, so the race
   * would shut down the app the first call had just started. Serialised per plugin
   * (not globally: two different Mini Apps have no reason to wait for each other)
   * the second call sees the first one's listener and replaces it.
   */
  const inFlight = new Map<string, Promise<void>>();

  function serialised<T>(pluginId: string, work: () => Promise<T>): Promise<T> {
    const tail = inFlight.get(pluginId) ?? Promise.resolve();
    const run = tail.then(work, work);
    // The tail must settle without rejecting: the next caller awaits it, and this
    // call's own failure already has a receiver.
    const settled = run.then(
      () => undefined,
      () => undefined,
    );
    inFlight.set(pluginId, settled);
    void settled.then(() => {
      if (inFlight.get(pluginId) === settled) inFlight.delete(pluginId);
    });
    return run;
  }

  /** Replaces the plugin's listener, closing the old one before binding the new. */
  function replaceProxy(target: MiniAppProxyTarget): Promise<MiniAppProxy> {
    return proxies.start({
      target,
      // The page bridge is injected into the document the proxy serves, and it has
      // to be there before the page's own scripts run — the Mini App asks for
      // `window.mcode.miniapp` as it boots.
      bridge: miniAppPageBridge(),
    });
  }

  async function closeProxy(pluginId: string): Promise<void> {
    await proxies.close(pluginId);
  }

  /**
   * Which presentations are live, and how many each plugin has had.
   *
   * Per handler set, so per service: the record describes the documents this
   * service is serving, and two services (a restart, a test) have no business
   * sharing one.
   */
  const presentations = createMiniAppPresentationLeases();
  /** Which generation of each plugin's page is the one being served. */
  const connections = options.connections ?? createMiniAppAgentConnections();
  const panels = options.panels ?? createMiniAppAgentPanels();
  const runs = options.runs ?? createMiniAppAgentRuns();

  /**
   * Whether the deep link's session is still there.
   *
   * `getSession` is the port's existing lookup, not a new capability: the
   * standalone presentation needs to say what its link named, and the session
   * business already answers that.
   *
   * Only a **confirmed absence** is `"ended"` — the runtime's own
   * `SESSION_NOT_FOUND`. Everything else is rethrown, because a host whose lookup
   * failed has said nothing about the person's session, and reporting that as
   * "ended" would turn an infrastructure failure into a fact about their data.
   * The stream still holds its presentation lease and reports an unresolved
   * session. That is distinct from a confirmed absence, and the standalone page
   * can keep rendering the plugin-scoped Mini App while saying lookup failed.
   */
  async function sessionStateOf(sessionId: string): Promise<"live" | "ended"> {
    const lookup = await port.getSession({ id: sessionId }).catch((error: unknown) => {
      if (isConfirmedMissingSession(error)) return undefined;
      throw error;
    });
    return lookup?.session ? "live" : "ended";
  }

  /**
   * The lease, held for as long as the caller's socket lives.
   *
   * One frame states the presentation; the stream then stays open, and the lease
   * is released when the stream is finished. Two things finish it and both reach
   * the same `finally`: the dispatcher breaks its pump when the connection's
   * signal aborts and then calls `return()`, and a consumer that stops reading
   * closes the socket, which aborts that same signal. Nothing here times out — a
   * tab is open until the person closes it.
   */
  async function* presentationSource(input: {
    readonly pluginId: string;
    readonly sessionId: string;
    readonly signal?: AbortSignal;
  }): AsyncGenerator<WebuiMiniAppPresentationState> {
    const lease = presentations.acquire({
      pluginId: input.pluginId,
      sessionId: input.sessionId,
    });
    try {
      let session: WebuiMiniAppPresentationState["session"];
      try {
        session = await sessionStateOf(input.sessionId);
      } catch {
        // Session lookup is observational. Keep the presentation lease alive and
        // report that the session could not be confirmed instead of treating the
        // whole Mini App document as absent or falsely calling the session ended.
        session = "unresolved";
      }
      yield {
        pluginId: lease.pluginId,
        sessionId: lease.sessionId,
        presentationRevision: lease.presentationRevision,
        session,
      };
      // No signal means no connection lifetime to hold the lease for, so the
      // frame is the whole answer rather than a lease nobody can release.
      if (!input.signal) return;
      if (input.signal.aborted) return;
      await new Promise<void>((resolve) => {
        input.signal?.addEventListener("abort", () => resolve(), { once: true });
      });
    } finally {
      presentations.release(lease);
    }
  }

  /**
   * The runtime's catalogue, with this service's presentation beside each row.
   *
   * The two fields are read from the lease record at the moment of the read, which
   * is what makes them a live fact: the inline view polls this operation, so a
   * standalone tab opening or closing changes the next answer.
   */
  const listMiniApps: DedicatedHandler<typeof listMiniAppsOperation> = async () => {
    const catalogue = await requireMiniApps(port).list.call(port);
    const miniApps = Array.isArray(catalogue?.miniApps) ? catalogue.miniApps : [];
    const body: WebuiMiniAppCatalogue = {
      miniApps: miniApps.map((row) => ({
        ...row,
        detached: presentations.detached(row.pluginId),
        presentationRevision: presentations.revision(row.pluginId),
      })),
    };
    return { body };
  };

  const watchMiniAppPresentation: DedicatedHandler<
    typeof watchMiniAppPresentationOperation
  > = async (context: WebuiOperationContext, body) => {
    // The lease presupposes the capability: presenting a Mini App a host cannot
    // list or stop is not a presentation, and the refusal must be the same one the
    // other three answer.
    requireMiniApps(port);
    return {
      stream: {
        ok: true,
        // The cast is the pattern the terminal watcher uses: the handler contract
        // admits the two data streams by name, while a watcher's frame type is its
        // own. The frame shape is declared on the descriptor
        // (`WebuiMiniAppPresentationStreamEnvelope`), which is where the client
        // reads it from.
        source: presentationSource({
          pluginId: body.pluginId,
          sessionId: body.sessionId,
          ...(context.signal ? { signal: context.signal } : {}),
        }) as unknown as AsyncIterable<Record<string, unknown>>,
      },
    };
  };

  const watchMiniAppPresenter: DedicatedHandler<typeof watchMiniAppPresenterOperation> = async (
    context: WebuiOperationContext,
  ) => {
    const presenter = options.presenter;
    if (!presenter) throw new Error("Mini App presenter is unavailable");
    const source = (async function* () {
      let wake: (() => void) | undefined;
      const queued = [] as ReturnType<MiniAppPresenterView["snapshot"]>[];
      const enqueue = (intent: NonNullable<ReturnType<MiniAppPresenterView["snapshot"]>>) => {
        queued.push(intent);
        wake?.();
      };
      const unsubscribe = presenter.subscribe(enqueue);
      const initial = presenter.snapshot();
      if (initial) queued.push(initial);
      try {
        while (!context.signal?.aborted) {
          const intent = queued.shift();
          if (intent) {
            yield intent;
            continue;
          }
          await new Promise<void>((resolve) => {
            const finish = (): void => {
              context.signal?.removeEventListener("abort", finish);
              wake = undefined;
              resolve();
            };
            wake = finish;
            context.signal?.addEventListener("abort", finish, { once: true });
          });
        }
      } finally {
        unsubscribe();
      }
    })();
    return { stream: { ok: true as const, source: source as AsyncIterable<Record<string, unknown>> } };
  };

  const openMiniApp: DedicatedHandler<typeof openMiniAppOperation> = async (
    context: WebuiOperationContext,
    body,
  ) => {
    const miniApps = requireMiniApps(port);
    return serialised(body.pluginId, async () => {
      const launch = await miniApps.open.call(port, {
        pluginId: body.pluginId,
        signal: context.signal,
      });
      try {
        const proxy = await replaceProxy({
          pluginId: launch.miniApp.pluginId,
          upstreamOrigin: launch.launch.origin,
          surfacePath: launch.launch.surfacePath,
          credential: launch.launch.credential,
          credentialHeader: launch.launch.credentialHeader,
          // The Agent may name the page inside the Mini App it wants. The proxy
          // resolves it against the Mini App's own origin, so the page the client
          // frames is the page the Mini App serves.
          ...(body.path !== undefined ? { path: body.path } : {}),
        });
        // The response is the proxy's URL, the plugin it belongs to, and the
        // generation this start issued. The runtime's origin, surface path,
        // credential and process generation stay in this frame of reference.
        const binding = connections.register({
          pluginId: launch.miniApp.pluginId,
          runId: launch.launch.runId,
        });
        return {
          body: {
            pluginId: launch.miniApp.pluginId,
            viewUrl: proxy.viewUrl,
            connection: binding.connection,
          },
        };
      } catch (error) {
        // The runtime started something the client cannot reach. Stopping it is
        // better than leaving a process running with no way into it, and the
        // original failure is what the caller needs to see.
        await miniApps.stop
          .call(port, { pluginId: body.pluginId, signal: context.signal })
          .catch(() => undefined);
        throw error;
      }
    });
  };

  const stopMiniApp: DedicatedHandler<typeof stopMiniAppOperation> = async (
    context: WebuiOperationContext,
    body,
  ) => {
    const miniApps = requireMiniApps(port);
    return serialised(body.pluginId, async () => {
      /**
       * The order is the point.
       *
       * 1. Close every panel this service told the runtime was on screen, while the
       *    generation that authorises the report is still current. A record left
       *    behind keeps a session's permission asks answerable, and after the revoke
       *    below the client could never withdraw it.
       * 2. Cancel the turns this client is following, so they settle as aborted
       *    instead of waiting for a stream the stop is about to close.
       * 3. Stop the runtime, close the listener, and only then revoke the
       *    generation: the page is gone with its listener, so nothing may act as
       *    this plugin any more and the next start is a new generation.
       */
      for (const panel of panels.forPlugin(body.pluginId)) {
        await port
          .panelClosedMiniAppAgentSession?.({
            sessionId: panel.sessionId,
            hostSessionId: panel.hostSessionId,
          })
          .catch(() => undefined);
      }
      runs.cancelPlugin(body.pluginId);
      await miniApps.stop.call(port, {
        pluginId: body.pluginId,
        signal: context.signal,
      });
      await closeProxy(body.pluginId);
      // Dropped only after the stop succeeded: a stop that threw leaves the listener
      // where it was for a retry, and a retry still has to know which panels to
      // close. The closes above are idempotent, so repeating them costs nothing.
      panels.take(body.pluginId);
      connections.revoke(body.pluginId);
      return { body: { success: true as const } };
    });
  };

  return new Map([
    [
      listMiniAppsOperation.name,
      {
        operation: listMiniAppsOperation,
        handle: listMiniApps as WebuiOperationHandler<unknown>,
      },
    ],
    [
      openMiniAppOperation.name,
      {
        operation: openMiniAppOperation,
        handle: openMiniApp as WebuiOperationHandler<unknown>,
      },
    ],
    [
      stopMiniAppOperation.name,
      {
        operation: stopMiniAppOperation,
        handle: stopMiniApp as WebuiOperationHandler<unknown>,
      },
    ],
    [
      watchMiniAppPresentationOperation.name,
      {
        operation: watchMiniAppPresentationOperation,
        handle: watchMiniAppPresentation as WebuiOperationHandler<unknown>,
      },
    ],
    [
      watchMiniAppPresenterOperation.name,
      {
        operation: watchMiniAppPresenterOperation,
        handle: watchMiniAppPresenter as WebuiOperationHandler<unknown>,
      },
    ],
  ]);
}
