// The WebUI's remote-control owner.
//
// It owns the bridge and answers the nine operations the 远程控制 tab issues. It is the
// WebUI's counterpart of the Desktop's Electron main-process glue (`ipc.js`), minus the parts
// that only exist because Electron splits a process in two.
//
// ## What the owner owns
//
//   * the **identity store** — this machine's stable device id and the account the phone is bound
//     to, persisted under `<dataDir>/remote-control/state.json`. It never holds a ticket or a
//     token: the file records *who* is bound, not *how* to connect.
//   * the **pairing client** — the HTTP side of the binding pipeline (see `pairing.ts`).
//   * the **credential** — the account lease the pairing pipeline signs with, handed down by the
//     assembly (see `pairing.ts`).
//   * the **proxy** — the bridge's facade: the WebSocket, the status machine, the credential
//     provider and the upstream subscriptions.
//   * the **status fan-out** — one snapshot, many subscribers: the browser's status stream and
//     the permission/composer notifications the phone produces.
//
// ## The split that stays
//
// The browser never holds the account credential, so the *service* signs the binding HTTP. The
// operation `applyRemoteControlCredentials` still exists and still works: a browser that has a
// signed ticket pushes it down, and the service opens the socket with it. Both paths land in the
// same place — the bridge's credential provider — so the socket behaves identically either way.
//
// ## Where the bearer comes from
//
// The service's OAuth lease — the one the quota and the daily check-in sign with, and the one
// the assembly owns. Desktop's main process cannot do this: under Shared OAuth it fails closed
// on the legacy SSO token projection, so its pairing-code request is unsigned. The WebUI's
// service holds a first-party lease, so it signs the pairing pipeline with that.
//
// ## What is never faked
//
// The phase reported here is the bridge's own phase. A phone that is not connected reads `idle`,
// `unbound` or `error`, and the error is the bridge's `last_error`. There is no path in this file
// that reports `connected` without the WebSocket handshake having completed.
import { join } from "node:path";

import { remoteControlDeviceName } from "./device-name.js";

import type {
  WebuiRemoteControlComposerMode,
  WebuiRemoteControlConnectRequest,
  WebuiRemoteControlConnectResult,
  WebuiRemoteControlCredentials,
  WebuiRemoteControlDisconnectRequest,
  WebuiRemoteControlOperationResult,
  WebuiRemoteControlPendingUnbind,
  WebuiRemoteControlStatus,
  WebuiRemoteControlEvent,
  WebuiWatchRemoteControlResult,
} from "../../shared/contracts/remote-control.js";
import type { WebuiRuntimeCliService, WebuiRuntimeHostHandle } from "../harness/host-contract.js";
import { requireCliService, requireDataDir } from "../harness/requirements.js";
import { createAttachmentFetcher, RemoteControlProxy } from "./bridge/index.js";
import { DeviceIdentityStore } from "./bridge/device-identity.js";
import type { RcWebSocketFactory } from "./bridge/connection.js";
import type { RCStatus, RcLogger, RcSessionComposerModeChange } from "./bridge/types.js";
import { createRemoteControlLocalRuntimeInvoke } from "./command-router.js";
import { createRemoteControlGlobalEventSource } from "./global-events.js";
import { createRemoteControlLogger } from "./logger.js";
import {
  createRemoteControlPairingClient,
  readLegacyAuthIdentity,
  RemoteControlCredentialSource,
} from "./pairing.js";

/** The bridge's own status, as the wire reads it. */
function toWebuiStatus(
  status: RCStatus,
  deviceId: string,
  deviceName: string,
): WebuiRemoteControlStatus {
  return {
    phase: status.phase,
    ...(status.binding_id !== undefined ? { bindingId: status.binding_id } : {}),
    ...(status.display_name !== undefined ? { displayName: status.display_name } : {}),
    ...(status.pairing_code !== undefined ? { pairingCode: status.pairing_code } : {}),
    ...(status.expires_in !== undefined ? { expiresIn: status.expires_in } : {}),
    ...(status.last_error !== undefined ? { lastError: { ...status.last_error } } : {}),
    ...(status.pending_unbind_request_id !== undefined
      ? { pendingUnbindRequestId: status.pending_unbind_request_id }
      : {}),
    deviceId,
    deviceName,
  };
}

/** The bridge's connect result, as the wire reads it. */
function toWebuiConnectResult(
  result: { phase: RCStatus["phase"]; pairing_code?: string; expires_in?: number; last_error?: { code: string; message: string } },
): WebuiRemoteControlConnectResult {
  return {
    phase: result.phase,
    ...(result.pairing_code !== undefined ? { pairingCode: result.pairing_code } : {}),
    ...(result.expires_in !== undefined ? { expiresIn: result.expires_in } : {}),
    ...(result.last_error !== undefined ? { error: result.last_error.message } : {}),
  };
}

export interface WebuiRemoteControlOptions {
  /** The runtime host; its `cliService` is the phone's way into the runtime. */
  readonly host: WebuiRuntimeHostHandle;
  readonly browserPort?: Pick<import("../port.js").WebuiBrowserPort, "getAuthorization" | "setAuthorization">;
  /** Overrides the log sink; a test captures the lines. */
  readonly logger?: RcLogger;
  /** Overrides the ambient fetch used by the pairing pipeline. */
  readonly fetchImpl?: typeof fetch;
  /** The host name the pairing request reports. */
  readonly getDeviceName?: () => string | undefined;
  /** The agent whose sessions the phone lists. */
  readonly agentName?: string;
  /** The socket the bridge opens; a test injects its own. */
  readonly wsFactory?: RcWebSocketFactory;
  /** How often the binding poll runs, in milliseconds. */
  readonly pollIntervalMs?: number;
  /**
   * How often the service asks the server which binding this device owns.
   *
   * The default is 5s. A test sets it lower to exercise the watcher without
   * waiting for the real cadence.
   */
  readonly bindingWatchIntervalMs?: number;
}

/** The nine operations, as the harness adapter forwards them. */
export interface WebuiRemoteControlController {
  readonly getStatus: () => Promise<WebuiRemoteControlStatus>;
  readonly watchStatus: () => Promise<WebuiWatchRemoteControlResult>;
  readonly connect: (
    request: WebuiRemoteControlConnectRequest,
  ) => Promise<WebuiRemoteControlConnectResult>;
  readonly disconnect: (
    request: WebuiRemoteControlDisconnectRequest,
  ) => Promise<WebuiRemoteControlOperationResult>;
  readonly applyCredentials: (
    request: WebuiRemoteControlCredentials,
  ) => Promise<WebuiRemoteControlOperationResult>;
  readonly reportBindingLost: () => Promise<WebuiRemoteControlOperationResult>;
  readonly getPendingUnbind: () => Promise<WebuiRemoteControlPendingUnbind | null>;
  readonly resolveUnbind: (request: {
    readonly requestId: string;
    readonly confirmed: boolean;
  }) => Promise<WebuiRemoteControlOperationResult>;
  readonly publishComposerMode: (
    request: WebuiRemoteControlComposerMode,
  ) => Promise<{ readonly accepted: boolean }>;
}

/**
 * Builds the controller.
 *
 * The bridge is created lazily on the first call, because the identity store writes to disk and
 * the pairing client reads the credential: a host that never touches the 远程控制 tab should not
 * create a device id.
 */
export function createWebuiRemoteControl(
  options: WebuiRemoteControlOptions,
): WebuiRemoteControlController {
  const logger =
    options.logger ??
    createRemoteControlLogger({
      // The bridge's own decisions live at the info level: whether the pairing
      // poll ran, what it saw, why a credential could not be renewed. They are
      // dropped by default because the bridge logs every frame, and a service
      // that is being debugged asks for them by name.
      verbose: process.env.WEBUI_REMOTE_CONTROL_VERBOSE === "1",
    });
  const host = options.host;
  let proxy: RemoteControlProxy | undefined;
  const subscribers = new Set<(event: WebuiRemoteControlEvent) => void>();

  const deviceId = (): string => {
    const store = identityStore();
    store.ensure();
    return store.getDeviceId();
  };

  const identityStore = (): DeviceIdentityStore => {
    const dataDir = requireDataDir(host);
    return new DeviceIdentityStore(join(dataDir, "remote-control", "state.json"), logger);
  };

  /**
   * The account credential the pairing pipeline signs with.
   *
   * The bearer is the service's OAuth lease, handed down by the assembly — the same lease the
   * quota and the daily check-in sign with. The legacy cli-auth projection is read only as a
   * fallback for the account id, because the server cross-checks the `user_id` common-param
   * against the token's own subject.
   */
  const credential = new RemoteControlCredentialSource(
    async () => {
      const provided = await host.getAuthCredential?.();
      if (provided?.accessToken) return provided;
      const realUserID = provided?.realUserID ?? readLegacyAuthIdentity(requireDataDir(host));
      return realUserID ? { realUserID } : undefined;
    },
    (message) => {
      // A renewal that failed is not a sign-out. Say so, and keep the bearer.
      logger.warn(`[rc.owner] the account credential was not renewed: ${message}`);
    },
  );

  /** The account the bridge binds the phone to. */
  const currentUserId = (): string | undefined => credential.userId;

  /**
   * The self-heal loop.
   *
   * The Desktop asks its renderer to re-sign; the WebUI has no renderer with the credential, so
   * the service re-signs for itself: it asks archon_biz for the current binding and, when the
   * binding is live, pushes the fresh one-shot ticket straight into the bridge.
   */
  /**
   * Fetches the binding this device owns and opens the socket with it.
   *
   * The guard is the important part. Applying the credentials invalidates the
   * bridge's pairing session — that is how the bridge says "these credentials
   * supersede what you had" — and the pairing session is what polls for the
   * phone's binding. So a caller that must not disturb a pairing in progress
   * (the relink) passes a guard, and the credentials are not applied when the
   * guard says no.
   */
  const refreshBinding = async (guard?: () => boolean): Promise<boolean> => {
    try {
      await credential.refresh();
      const info = await pairingClient().getBinding();
      if (info.state === "bound" && info.ticket && info.endpoint && info.binding_id !== undefined) {
        if (guard && !guard()) {
          logger.info("[rc.owner] a pairing is in progress; the binding refresh stood down");
          return false;
        }
        ensureProxy().applyRendererCredentials({
          binding_id: info.binding_id,
          ticket: info.ticket,
          endpoint: info.endpoint,
          ...(info.producer_generation !== undefined
            ? { producer_generation: info.producer_generation }
            : {}),
        });
        logger.info("[rc.owner] refreshed the binding from the server after a credential refresh");
        // The ticket is one-shot: the socket has to be opened with the fresh one.
        await ensureProxy().connect();
        return true;
      }
      logger.info(`[rc.owner] binding refresh found no usable binding state=${info.state ?? "none"}`);
      return false;
    } catch (error) {
      logger.warn(
        `[rc.owner] binding refresh failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      return false;
    }
  };

  const pairingClient = () =>
    createRemoteControlPairingClient({
      dataDir: requireDataDir(host),
      getDeviceId: deviceId,
      appVersion: host.appVersion ?? "webui",
      credential,
      logger,
      ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
      ...(options.getDeviceName ? { getDeviceName: options.getDeviceName } : {}),
    });

  const cliService = (): WebuiRuntimeCliService => requireCliService(host);

  const emit = (event: WebuiRemoteControlEvent): void => {
    for (const subscriber of subscribers) subscriber(event);
  };

  const ensureProxy = (): RemoteControlProxy => {
    if (proxy) return proxy;
    const service = cliService();
    const store = identityStore();
    proxy = new RemoteControlProxy({
      identity: store,
      pairingClient: pairingClient(),
      logger,
      clientVersion: host.appVersion ?? "webui",
      // The runtime is in-process: while the service lives, the runtime lives with it.
      isRuntimeHealthy: () => true,
      getCurrentUserId: currentUserId,
      requestRendererRefresh: () => {
        void refreshBinding();
      },
      onSessionComposerModeChange: (change: RcSessionComposerModeChange) => {
        emit({
          type: "composer-mode",
          composerMode: { sessionId: change.sessionId, mode: change.mode },
        });
      },
      globalEventSource: createRemoteControlGlobalEventSource({ cliService: service }),
      attachmentFetcher: createAttachmentFetcher({
        saveDir: join(requireDataDir(host), "remote-control", "attachments"),
        logger,
        ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
      }),
      // The bridge assembles its own command router once a local-runtime entrypoint
      // exists: it owns the command vocabulary and the phone-side shapes, so the
      // WebUI only supplies the `Request -> Response` seam.
      localRuntimeInvoke: createRemoteControlLocalRuntimeInvoke({
        cliService: service,
        logger,
        ...(options.browserPort ? { browserPort: options.browserPort } : {}),
        ...(options.agentName === undefined ? {} : { agentName: options.agentName }),
      }),
      ...(options.wsFactory ? { wsFactory: options.wsFactory } : {}),
      ...(options.pollIntervalMs === undefined ? {} : { pollIntervalMs: options.pollIntervalMs }),
    });
    // The proxy lives for as long as the service does, so the subscription is never released.
    proxy.onStatusChange((status) => {
      emit({
        type: "status",
        status: toWebuiStatus(status, deviceId(), deviceName()),
      });
    });
    // From here on the service watches its binding: the phone may pair again,
    // and this service may have started after the phone paired.
    startBindingWatcher();
    return proxy;
  };

  // The device name the panel shows is the same name this device reports when it asks for a
  // pairing code (`pairing.ts` sends it to the server), so the panel and the phone call this
  // machine by the same name. Both sides read `remoteControlDeviceName()`, which appends the
  // operating system to the hostname.
  const deviceName = (): string => options.getDeviceName?.() || remoteControlDeviceName();

  /**
   * Re-establish the link when the service comes back.
   *
   * The Desktop's renderer pushes the binding down when it starts; the WebUI's
   * service has no renderer with the credential, so the service does it for
   * itself: it asks archon_biz for the binding it already owns and opens the
   * socket with a fresh one-shot ticket. Without this, a service restart would
   * leave the phone paired but the producer offline, and only a second pairing
   * would bring it back.
   *
   * The server's answer is the authority, not the local copy: the local
   * `binding_id` is only written once the pairing completes, so a service that
   * died between the phone's binding and the poll's discovery would otherwise
   * have nothing to relink to. A host that never paired asks once and then
   * stops asking; the cooldown keeps the rest from turning into a request loop.
   */
  /**
   * The binding watcher.
   *
   * The Desktop's renderer owns the binding: it asks the server which binding
   * this device has and pushes it down whenever that changes. The WebUI's
   * service has no renderer with the credential, so the service does it for
   * itself — and it has to keep doing it, for two reasons the Desktop never
   * has to think about:
   *
   *   * the binding id changes every time the phone pairs again, and the
   *     producer has to follow it to the new one;
   *   * a service that starts (or restarts) after the phone paired has to find
   *     the binding the phone is waiting for. The bridge's own pairing poll
   *     cannot do that: it only lives inside a pairing window and it confirms
   *     whichever binding exists when it first ticks — which, right after a
   *     second pairing, is the *previous* one.
   *
   * The watcher therefore asks the server, compares the binding id with the one
   * in use, and applies the credentials when they differ. The bridge treats a
   * rotated binding as a credential refresh and reconnects on the new one.
   *
   * A pairing in progress owns its own poll, so the watcher stands down while
   * the phase is pairing — otherwise it would invalidate that poll.
   */
  let watchTimer: NodeJS.Timeout | undefined;
  let watching = false;
  const watchBinding = async (): Promise<void> => {
    if (watching) return;
    watching = true;
    try {
      const current = ensureProxy().getStatus();
      if (current.phase === "pairing") return;
      // The watcher is the first thing this service does with the credential,
      // so it reads it before it asks anything of the server.
      await credential.refresh();
      const info = await pairingClient().getBinding();
      if (info.state !== "bound" || info.binding_id === undefined) return;
      if (!info.ticket || !info.endpoint) return;
      const inUse = identityStore().ensure().binding_id;
      if (info.binding_id === inUse && current.phase === "connected") return;
      logger.info(
        `[rc.owner] the server reports binding ${info.binding_id} (in use: ${inUse ?? "none"}); applying it`,
      );
      const rotated = inUse !== undefined && inUse !== info.binding_id;
      ensureProxy().applyRendererCredentials({
        binding_id: info.binding_id,
        ticket: info.ticket,
        endpoint: info.endpoint,
        ...(info.producer_generation !== undefined
          ? { producer_generation: info.producer_generation }
          : {}),
      });
      if (rotated) {
        // The bridge keeps a live socket when the binding rotates — the socket
        // may still be carrying other consumers — but the gateway routes by
        // binding, and the phone is on the new one. The socket has to be
        // re-opened against the new binding, or the phone keeps seeing the
        // desktop as offline.
        logger.info(
          `[rc.owner] the binding rotated ${inUse} -> ${info.binding_id}; re-opening the socket`,
        );
        await ensureProxy().disconnect({ unbind: false });
      }
      await ensureProxy().connect();
    } catch (error) {
      logger.warn(
        `[rc.owner] binding watch failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      watching = false;
    }
  };
  const startBindingWatcher = (): void => {
    if (watchTimer) return;
    watchTimer = setInterval(() => {
      void watchBinding();
    }, options.bindingWatchIntervalMs ?? 5_000);
    // The watcher must not keep the service alive on its own.
    watchTimer.unref?.();
  };

  const status = (): WebuiRemoteControlStatus =>
    toWebuiStatus(
      ensureProxy().getStatus(),
      deviceId(),
      deviceName(),
    );

  return {
    async getStatus() {
      return status();
    },

    async watchStatus(): Promise<WebuiWatchRemoteControlResult> {
      try {
        ensureProxy();
      } catch (error) {
        return {
          ok: false,
          status: 503,
          body: {
            message:
              error instanceof Error
                ? error.message
                : "the remote-control link cannot be hosted by this runtime",
          },
        };
      }
      const source = (async function* (): AsyncIterable<WebuiRemoteControlEvent> {
        // The stream has two producers: the bridge's status changes and the
        // runtime's permission questions. The status changes arrive through the
        // owner's fan-out, so they land in a queue; the permission questions
        // arrive on their own iterable. The stream waits for whichever comes
        // first.
        //
        // The earlier shape re-emitted the owner's events into the owner's own
        // subscriber set — the set this subscriber belongs to — so every status
        // change recursed until the stack ran out, and the browser received
        // nothing at all. The queue is what makes the fan-out one-way.
        const queue: WebuiRemoteControlEvent[] = [];
        let wake: (() => void) | undefined;
        const push = (event: WebuiRemoteControlEvent): void => {
          queue.push(event);
          const resume = wake;
          wake = undefined;
          resume?.();
        };
        subscribers.add(push);
        // The permission stream is stopped at the source: closing its iterator
        // would wait for an iteration that may never finish, and a stream that
        // cannot be closed is a stream that leaks its subscription.
        const permissionController = new AbortController();
        const permissions = watchPermissionQuestions(
          cliService(),
          permissionController.signal,
        )[Symbol.asyncIterator]();
        let pendingPermission = permissions.next();
        try {
          // The first frame is the snapshot, so a browser that opens the tab late still learns
          // the current phase without asking for it separately.
          yield { type: "status", status: status() };
          for (;;) {
            if (queue.length > 0) {
              yield queue.shift()!;
              continue;
            }
            const next = await Promise.race([
              pendingPermission.then((result) => ({ permission: result })),
              new Promise<{ readonly queued: true }>((resolve) => {
                wake = () => resolve({ queued: true });
              }),
            ]);
            if ("queued" in next) continue;
            if (next.permission.done) {
              // The permission stream ended; the status changes keep coming.
              pendingPermission = new Promise<IteratorResult<WebuiRemoteControlEvent>>(() => {});
              continue;
            }
            yield next.permission.value;
            pendingPermission = permissions.next();
          }
        } finally {
          subscribers.delete(push);
          wake?.();
          permissionController.abort();
          void permissions.return?.(undefined);
        }
      })();
      return { ok: true, source };
    },

    async connect(request: WebuiRemoteControlConnectRequest) {
      const bridge = ensureProxy();
      try {
        // The pairing code is an archon_biz request, so it is signed with the
        // account credential. It is read here, not captured: the lease is
        // refreshed in place and a captured token is a token that expires.
        await credential.refresh();
        if (request.requestCode === true) {
          return toWebuiConnectResult(await bridge.requestPairingCode());
        }
        const result = await bridge.connect();
        // Nothing to connect to and nothing bound: the only way forward is a pairing code.
        if (result.phase === "idle" || result.phase === "unbound") {
          return toWebuiConnectResult(await bridge.requestPairingCode());
        }
        return toWebuiConnectResult(result);
      } catch (error) {
        logger.error(
          `[rc.owner] connect failed: ${error instanceof Error ? error.message : String(error)}`,
        );
        return {
          phase: "error",
          error: error instanceof Error ? error.message : String(error),
        };
      }
    },

    async disconnect(request: WebuiRemoteControlDisconnectRequest) {
      const bridge = ensureProxy();
      try {
        // The unbind is an archon_biz request, so it needs the same bearer.
        if (request.unbind === true) await credential.refresh();
        await bridge.disconnect({ unbind: request.unbind === true });
        return { success: true };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error(`[rc.owner] disconnect failed: ${message}`);
        return { success: false, error: message };
      }
    },

    async applyCredentials(request: WebuiRemoteControlCredentials) {
      const bridge = ensureProxy();
      try {
        const accepted = bridge.applyRendererCredentials({
          binding_id: request.bindingId,
          ticket: request.ticket,
          endpoint: request.endpoint,
          ...(request.producerGeneration !== undefined
            ? { producer_generation: request.producerGeneration }
            : {}),
          ...(request.requestEpoch !== undefined ? { request_epoch: request.requestEpoch } : {}),
        });
        if (!accepted) {
          return { success: false, error: "the credential belongs to an earlier connection" };
        }
        const result = await bridge.connect();
        if (result.phase === "error") {
          return {
            success: false,
            error: result.last_error?.message ?? "the phone link could not be opened",
          };
        }
        return { success: true };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error(`[rc.owner] applying credentials failed: ${message}`);
        return { success: false, error: message };
      }
    },

    async reportBindingLost() {
      const bridge = ensureProxy();
      try {
        bridge.onRendererBindingLost();
        return { success: true };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error(`[rc.owner] reporting the binding lost failed: ${message}`);
        return { success: false, error: message };
      }
    },

    async getPendingUnbind() {
      const bridge = ensureProxy();
      const pending = bridge.getPendingProducerUnbind();
      if (!pending) return null;
      return {
        requestId: pending.request_id,
        createdAtMs: pending.created_at_ms,
        attempts: pending.attempts,
        ...(pending.binding_id !== undefined ? { bindingId: pending.binding_id } : {}),
      };
    },

    async resolveUnbind(request: { readonly requestId: string; readonly confirmed: boolean }) {
      const bridge = ensureProxy();
      try {
        bridge.resolveProducerUnbind(
          request.confirmed ? "confirmed" : "rejected",
          request.confirmed ? "the browser confirmed the unbind" : "the browser rejected the unbind",
        );
        return { success: true };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error(`[rc.owner] resolving the unbind failed: ${message}`);
        return { success: false, error: message };
      }
    },

    async publishComposerMode(request: WebuiRemoteControlComposerMode) {
      const bridge = ensureProxy();
      try {
        const accepted = bridge.publishSessionComposerMode({
          sessionId: request.sessionId,
          mode: request.mode,
        });
        return { accepted };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error(`[rc.owner] publishing the composer mode failed: ${message}`);
        return { accepted: false };
      }
    },
  };
}

/**
 * The runtime's permission questions, as the browser's stream frames.
 *
 * The phone's answer travels the other way (the command router's `cmd.permission.respond`); this
 * is the direction that tells the browser a question is waiting, so the 远程控制 tab can show it.
 */
async function* watchPermissionQuestions(
  cliService: WebuiRuntimeCliService,
  signal?: AbortSignal,
): AsyncIterable<WebuiRemoteControlEvent> {
  const controller = new AbortController();
  // The caller's signal stops the subscription: the caller closes the stream
  // while the runtime's event iterator is still waiting for its next event.
  const stop = (): void => controller.abort();
  signal?.addEventListener("abort", stop, { once: true });
  try {
    for await (const event of cliService.watchEvents(controller.signal)) {
      if (event.type !== "permission.ask") continue;
      const payload = event.payload as {
        readonly requestId?: string;
        readonly sessionId?: string;
        readonly toolName?: string;
      };
      if (!payload.requestId) continue;
      yield {
        type: "permission",
        permission: {
          requestId: payload.requestId,
          ...(payload.sessionId === undefined ? {} : { sessionId: payload.sessionId }),
          ...(payload.toolName === undefined ? {} : { toolName: payload.toolName }),
        },
      };
    }
  } finally {
    controller.abort();
    signal?.removeEventListener("abort", stop);
  }
}

