// The delivery disposers the application actually holds.
//
// A version guard rejects a superseded attempt's commits but does not cancel its
// IO: something has to close the client's half of the delivery. That something is
// this registry — the stream/watch/request handles handed up by the transport as
// each attempt opens.
//
// What closing one means is deliberately narrow. It stops **this client**
// observing the attempt: no further frames are delivered and the wire session is
// closed. It never aborts the host turn, and it never revokes an already accepted
// host mutation — cancelling those stays an explicit command (`stop`), because a
// detached observer and a cancelled turn are different things (ADR 0017).

import type { WebuiDeliveryHandle } from "../contracts/execution-port.js";
import type { WebuiSessionScopeManager } from "../../../conversation/session-scope.js";

/** One attempt owns both its transport registration and its session interest. */
export function holdWebuiDelivery(
  sessionId: () => string,
  deliveries?: WebuiDeliveryDisposers,
  scope?: WebuiSessionScopeManager,
): { readonly onDelivery: (handle: WebuiDeliveryHandle) => void; readonly release: () => void } {
  let releaseHandle: (() => void) | undefined;
  let releaseInterest: (() => void) | undefined;
  let ended = false;
  const holder = `attempt:${++nextHolder}`;
  const release = (): void => {
    releaseHandle?.(); releaseInterest?.();
    releaseHandle = undefined; releaseInterest = undefined;
  };
  return {
    onDelivery: (handle) => {
      release();
      if (ended || deliveries?.isDisposed() || scope?.isDisposed()) {
        handle.close();
        return;
      }
      const key = sessionId();
      releaseInterest = scope?.acquire(key, "delivery", holder);
      if (scope && !scope.isInterested(key)) {
        releaseInterest?.(); releaseInterest = undefined;
        handle.close();
        return;
      }
      releaseHandle = deliveries?.track(key, { close: () => {
        releaseInterest?.(); releaseInterest = undefined;
        handle.close();
      } });
    },
    release: () => { ended = true; release(); },
  };
}

let nextHolder = 0;

export interface WebuiDeliveryDisposers {
  /**
   * Registers one attempt's real disposer against its session. Returns this
   * registration's own release, so a loop that ends normally removes exactly its
   * own handle and not a newer attempt's.
   */
  readonly track: (sessionId: string, handle: WebuiDeliveryHandle) => () => void;
  /**
   * Closes every delivery for one session: supersession (a newer attempt owns
   * the stream now), purge, or an explicit detach.
   */
  readonly closeSession: (sessionId: string) => void;
  /** Closes every client delivery; application disposal. */
  readonly closeAll: () => void;
  /** How many deliveries are still open, per session. */
  readonly count: (sessionId?: string) => number;
  readonly isDisposed: () => boolean;
}

export function createWebuiDeliveryDisposers(): WebuiDeliveryDisposers {
  const open = new Map<string, Map<symbol, WebuiDeliveryHandle>>();
  let disposed = false;

  const close = (handle: WebuiDeliveryHandle): void => {
    try {
      handle.close();
    } catch (error) {
      // A delivery that refuses to close must not stop the others from closing:
      // this runs on the disposal path, which has to finish.
      // eslint-disable-next-line no-console
      console.error("[webui] delivery close failed:", error);
    }
  };

  return {
    track: (sessionId, handle) => {
      const key = Symbol("delivery");
      if (!disposed) {
        const held = open.get(sessionId) ?? new Map<symbol, WebuiDeliveryHandle>();
        held.set(key, handle);
        open.set(sessionId, held);
      }
      return () => {
        // The caller's release means the attempt ended on its own: the transport
        // already closed the wire session, and closing here would be a second
        // close of something already gone.
        const held = open.get(sessionId);
        if (!held) return;
        if (!held.delete(key)) return;
        if (held.size === 0) open.delete(sessionId);
      };
    },
    closeSession: (sessionId) => {
      const held = open.get(sessionId);
      if (!held) return;
      open.delete(sessionId);
      for (const handle of held.values()) close(handle);
    },
    closeAll: () => {
      // The disposal path: nothing may be registered afterwards, so an attempt
      // that opens during teardown is never held by a dead registry.
      disposed = true;
      for (const [sessionId, held] of [...open]) {
        open.delete(sessionId);
        for (const handle of held.values()) close(handle);
      }
    },
    count: (sessionId) =>
      sessionId === undefined
        ? [...open.values()].reduce((total, held) => total + held.size, 0)
        : (open.get(sessionId)?.size ?? 0),
    isDisposed: () => disposed,
  };
}
