// The 远程控制 owner.
//
// Framework-free — no React, no DOM — so the transitions are testable against a scripted port
// (`packages/webui/AGENTS.md`: no jsdom in this package).
//
// Three facts it has to get right:
//
//   * **The phase is the host's, not the page's.** The browser never decides that a phone is
//     linked; it reads the bridge's phase and renders it. An unwired transport is not "not
//     linked" — it is "this host cannot host a phone link", and the two are different answers.
//   * **A pairing code expires.** The code the user types into the MiniMax App is good for a
//     while and then it is not. The owner records the moment it stops being valid, and the
//     projection drops the code when that moment has passed — an expired code shown as if it
//     were live is worse than no code.
//   * **A refresh keeps the page on screen.** Re-reading the status replaces the link's state
//     only when an answer arrives; a request in flight shows the previous state, because a page
//     that blanks out is worse than one that is a little stale.
//
// ## Where the snapshot's types live
//
// The snapshot is what the projection reads, so its types live in the projection: a projection
// must not import the application, and the edge the dependency gate flagged was exactly that.
// They are re-exported here under their own names so the published panel's existing import —
// `from "../application/remote-control-owner.js"` — keeps working.
import type {
  WebuiRemoteControlComposerMode,
  WebuiRemoteControlEvent,
  WebuiRemoteControlPhase,
  WebuiRemoteControlStatus,
} from "../../../../shared/contracts/remote-control.js";
import type { RemoteControlPort } from "../contracts/remote-control-port.js";
import type {
  WebuiRemoteControlOwnerStatus,
  WebuiRemoteControlSnapshot,
} from "../projection/remote-control-panel.js";

export type {
  WebuiRemoteControlOwnerStatus,
  WebuiRemoteControlSnapshot,
} from "../projection/remote-control-panel.js";

/** What a mutation answered. */
export type WebuiRemoteControlMutation =
  | { readonly ok: true }
  | { readonly ok: false; readonly message: string };

export interface WebuiRemoteControlOwner {
  readonly subscribe: (listener: () => void) => () => void;
  readonly getSnapshot: () => WebuiRemoteControlSnapshot;
  /** Reads the link once. Concurrent calls share one request. */
  readonly load: () => Promise<void>;
  /** Subscribes to the live state. Returns the stop function. */
  readonly startWatching: () => () => void;
  /** Opens the link: a fresh pairing code, which the user types into the MiniMax App. */
  readonly connect: () => Promise<WebuiRemoteControlMutation>;
  /** Closes the link, optionally dropping the phone binding with it. */
  readonly disconnect: (options?: { readonly unbind?: boolean }) => Promise<WebuiRemoteControlMutation>;
  /** Confirms or rejects a pending producer-wide unbind. */
  readonly resolveUnbind: (confirmed: boolean) => Promise<WebuiRemoteControlMutation>;
}

export const WEBUI_REMOTE_CONTROL_UNAVAILABLE =
  "这个运行时无法托管手机远程控制（宿主没有远程控制能力）。";
export const WEBUI_REMOTE_CONTROL_READ_FAILED = "读取手机远程控制状态失败。";
export const WEBUI_REMOTE_CONTROL_ACTION_FAILED = "操作手机远程控制失败。";
export const WEBUI_REMOTE_CONTROL_STREAM_UNAVAILABLE =
  "这个运行时无法推送手机远程控制状态。";

export interface CreateWebuiRemoteControlOwnerOptions {
  readonly port: RemoteControlPort;
  readonly nowMs?: () => number;
}

export function createWebuiRemoteControlOwner(
  options: CreateWebuiRemoteControlOwnerOptions,
): WebuiRemoteControlOwner {
  const nowMs = options.nowMs ?? Date.now;
  const listeners = new Set<() => void>();
  let snapshot: WebuiRemoteControlSnapshot = { status: "idle" };
  let inFlight: Promise<void> | undefined;

  const publish = (next: WebuiRemoteControlSnapshot): void => {
    snapshot = next;
    for (const listener of listeners) listener();
  };

  /** Applies a bridge snapshot, keeping the expiry honest. */
  const applyLink = (
    link: WebuiRemoteControlStatus,
    status: WebuiRemoteControlOwnerStatus,
  ): void => {
    const atMs = nowMs();
    publish({
      status,
      link,
      ...(link.expiresIn === undefined
        ? {}
        : { pairingExpiresAtMs: atMs + link.expiresIn * 1_000 }),
      ...(snapshot.pendingUnbind === undefined ? {} : { pendingUnbind: snapshot.pendingUnbind }),
      ...(snapshot.error === undefined ? {} : { error: snapshot.error }),
      loadedAtMs: atMs,
    });
  };

  const load = async (): Promise<void> => {
    if (inFlight) return inFlight;
    const read = options.port.getRemoteControlStatus;
    if (!read) {
      publish({ status: "unavailable", error: WEBUI_REMOTE_CONTROL_UNAVAILABLE });
      return;
    }
    publish({ ...snapshot, status: "loading" });
    inFlight = (async () => {
      try {
        const link = await read();
        applyLink(link, "ready");
      } catch (error) {
        publish({
          ...snapshot,
          status: "error",
          error: describeError(error, WEBUI_REMOTE_CONTROL_READ_FAILED),
        });
      } finally {
        inFlight = undefined;
      }
    })();
    return inFlight;
  };

  const loadPendingUnbind = async (): Promise<void> => {
    const read = options.port.getRemoteControlPendingUnbind;
    if (!read) return;
    try {
      const pending = await read();
      publish({
        ...snapshot,
        ...(pending ? { pendingUnbind: pending } : { pendingUnbind: undefined }),
      });
    } catch {
      // A pending unbind is a side note on the page; failing to read it must not hide the link.
    }
  };

  const startWatching = (): (() => void) => {
    const watch = options.port.watchRemoteControlStatus;
    if (!watch) {
      publish({ ...snapshot, status: "unavailable", error: WEBUI_REMOTE_CONTROL_STREAM_UNAVAILABLE });
      return () => undefined;
    }
    let stopped = false;
    const stop = watch((frame) => {
      if (stopped) return;
      const event = readEvent(frame);
      if (!event) return;
      if (event.type === "status") {
        applyLink(event.status, "ready");
        return;
      }
      // A composer-mode or permission frame does not change the link's state; it is carried to
      // the page through the same snapshot so one subscription serves the whole tab.
      publish({ ...snapshot });
    });
    return () => {
      stopped = true;
      stop();
    };
  };

  return {
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    getSnapshot: () => snapshot,
    load: async () => {
      await load();
      await loadPendingUnbind();
    },
    startWatching: () => startWatching(),
    connect: async () => {
      const connect = options.port.connectRemoteControl;
      if (!connect) {
        publish({ ...snapshot, status: "unavailable", error: WEBUI_REMOTE_CONTROL_UNAVAILABLE });
        return { ok: false, message: WEBUI_REMOTE_CONTROL_UNAVAILABLE };
      }
      try {
        // The Desktop's 连接 button always re-arms the pairing flow, so a second phone can be
        // paired without an unbind first.
        const result = await connect({ requestCode: true });
        if (result.phase === "error") {
          const message = result.error ?? WEBUI_REMOTE_CONTROL_ACTION_FAILED;
          publish({ ...snapshot, status: "error", error: message });
          return { ok: false, message };
        }
        await load();
        return { ok: true };
      } catch (error) {
        const message = describeError(error, WEBUI_REMOTE_CONTROL_ACTION_FAILED);
        publish({ ...snapshot, status: "error", error: message });
        return { ok: false, message };
      }
    },
    disconnect: async (disconnectOptions) => {
      const disconnect = options.port.disconnectRemoteControl;
      if (!disconnect) {
        publish({ ...snapshot, status: "unavailable", error: WEBUI_REMOTE_CONTROL_UNAVAILABLE });
        return { ok: false, message: WEBUI_REMOTE_CONTROL_UNAVAILABLE };
      }
      try {
        const result = await disconnect({
          ...(disconnectOptions?.unbind === undefined
            ? {}
            : { unbind: disconnectOptions.unbind }),
        });
        if (!result.success) {
          const message = result.error ?? WEBUI_REMOTE_CONTROL_ACTION_FAILED;
          publish({ ...snapshot, status: "error", error: message });
          return { ok: false, message };
        }
        await load();
        return { ok: true };
      } catch (error) {
        const message = describeError(error, WEBUI_REMOTE_CONTROL_ACTION_FAILED);
        publish({ ...snapshot, status: "error", error: message });
        return { ok: false, message };
      }
    },
    resolveUnbind: async (confirmed) => {
      const resolve = options.port.resolveRemoteControlUnbind;
      const pending = snapshot.pendingUnbind;
      if (!resolve || !pending) {
        return { ok: false, message: WEBUI_REMOTE_CONTROL_ACTION_FAILED };
      }
      try {
        const result = await resolve({ requestId: pending.requestId, confirmed });
        if (!result.success) {
          const message = result.error ?? WEBUI_REMOTE_CONTROL_ACTION_FAILED;
          publish({ ...snapshot, status: "error", error: message });
          return { ok: false, message };
        }
        publish({ ...snapshot, pendingUnbind: undefined });
        await load();
        return { ok: true };
      } catch (error) {
        const message = describeError(error, WEBUI_REMOTE_CONTROL_ACTION_FAILED);
        publish({ ...snapshot, status: "error", error: message });
        return { ok: false, message };
      }
    },
  };
}

/** The reason an operation failed, as the page shows it. */
function describeError(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message.trim() !== "") return error.message;
  return fallback;
}

const PHASES: readonly WebuiRemoteControlPhase[] = [
  "idle",
  "pairing",
  "connecting",
  "connected",
  "reconnecting",
  "error",
  "unbound",
];

/**
 * The frame the host streamed, as an event.
 *
 * The wire carries whatever the host sent, so the owner is the place that decides what a frame
 * means. A frame that is not one of the three known shapes is dropped rather than half-applied.
 */
function readEvent(frame: unknown): WebuiRemoteControlEvent | undefined {
  if (!frame || typeof frame !== "object" || Array.isArray(frame)) return undefined;
  const value = frame as Record<string, unknown>;
  if (value.type === "status") {
    const status = value.status;
    if (!status || typeof status !== "object" || Array.isArray(status)) return undefined;
    const phase = (status as { readonly phase?: unknown }).phase;
    if (typeof phase !== "string" || !PHASES.includes(phase as WebuiRemoteControlPhase)) {
      return undefined;
    }
    return { type: "status", status: status as WebuiRemoteControlStatus };
  }
  if (value.type === "composer-mode") {
    const composerMode = value.composerMode;
    if (!composerMode || typeof composerMode !== "object" || Array.isArray(composerMode)) {
      return undefined;
    }
    return {
      type: "composer-mode",
      composerMode: composerMode as WebuiRemoteControlComposerMode,
    };
  }
  if (value.type === "permission") {
    const permission = value.permission;
    if (!permission || typeof permission !== "object" || Array.isArray(permission)) return undefined;
    const requestId = (permission as { readonly requestId?: unknown }).requestId;
    if (typeof requestId !== "string" || requestId === "") return undefined;
    return { type: "permission", permission: permission as { readonly requestId: string } };
  }
  return undefined;
}
