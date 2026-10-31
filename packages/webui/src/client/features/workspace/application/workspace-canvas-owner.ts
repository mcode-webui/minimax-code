// The workspace canvas owner.
//
// The canvas document is a resource of the session it belongs to, and a canvas
// operation is a mutation whose outcome the surface must show. Both were the view's
// own component state, which meant the *document* and the *mutation outcome* lived
// in the same place as the pan, the zoom and the gesture — geometry that is the
// presentation's business. Here the document, its freshness and the mutation
// outcome have an owner; the view keeps the geometry.
//
// Freshness is by sequence, as it was in the view: a read or an apply for a session
// the user has left can no longer commit.

import type {
  CanvasOperation,
  WebuiCanvasDocument,
} from "../../../../shared/contracts/canvas.js";

export interface WebuiWorkspaceCanvasPort {
  readonly readCanvas?: (request: {
    readonly sessionId: string;
  }) => Promise<WebuiCanvasDocument>;
  readonly applyCanvas?: (request: {
    readonly sessionId: string;
    readonly operation: CanvasOperation;
  }) => Promise<{
    readonly operationId: string;
    readonly document: WebuiCanvasDocument;
  }>;
}

export interface WebuiWorkspaceCanvasState {
  /** The session the document belongs to, so a reader can tell whose it is. */
  readonly sessionId?: string;
  readonly document?: WebuiCanvasDocument;
  readonly status: "idle" | "loading" | "ready" | "error";
  readonly error?: string;
  /** True while an operation is in flight; the surface disables its controls. */
  readonly busy: boolean;
}

export const initialWebuiWorkspaceCanvasState: WebuiWorkspaceCanvasState = {
  status: "idle",
  busy: false,
};

export interface WebuiWorkspaceCanvasOwner {
  readonly state: () => WebuiWorkspaceCanvasState;
  readonly subscribe: (listener: () => void) => () => void;
  readonly canRead: boolean;
  readonly canApply: boolean;
  /** Read the session's canvas. A read for a session already left is dropped. */
  readonly read: (sessionId: string) => void;
  /**
   * Run one canvas operation. Resolves with `true` when it landed, so the surface
   * can run its own post-success work (clearing a preview, closing a draft field).
   */
  readonly apply: (
    sessionId: string,
    operation: CanvasOperation,
  ) => Promise<boolean>;
  /**
   * Release one session's canvas state.
   *
   * A deleted session's document is not a document any more, and an in-flight read
   * for it must not land afterwards: the sequence advances, so the answer that
   * was coming has nobody left to commit to.
   */
  readonly release: (sessionId: string) => void;
  readonly dispose: () => void;
}

function message(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason);
}

export function createWebuiWorkspaceCanvasOwner(deps: {
  readonly port: WebuiWorkspaceCanvasPort;
}): WebuiWorkspaceCanvasOwner {
  const { port } = deps;
  let state = initialWebuiWorkspaceCanvasState;
  const listeners = new Set<() => void>();
  let readSeq = 0;
  let applySeq = 0;

  const set = (update: (current: WebuiWorkspaceCanvasState) => WebuiWorkspaceCanvasState): void => {
    const next = update(state);
    if (next === state) return;
    state = next;
    for (const listener of [...listeners]) listener();
  };

  /**
   * Drop the session's canvas: supersede its in-flight read, then clear the entry
   * if it is the one on screen. The next session's read starts from idle rather
   * than inheriting a document that belonged to a session that no longer exists.
   */
  const release = (sessionId: string): void => {
    readSeq += 1;
    set((current) => (current.sessionId === sessionId ? initialWebuiWorkspaceCanvasState : current));
  };

  const read = (sessionId: string): void => {
    const readCanvas = port.readCanvas;
    const mine = ++readSeq;
    if (!readCanvas) {
      set(() => ({ sessionId, status: "idle", busy: false }));
      return;
    }
    set((current) =>
      current.sessionId === sessionId
        ? { ...current, status: "loading" }
        : { sessionId, status: "loading", busy: false },
    );
    void readCanvas({ sessionId })
      .then((document) => {
        if (mine !== readSeq) return;
        set(() => ({ sessionId, document, status: "ready", busy: false }));
      })
      .catch((reason: unknown) => {
        if (mine !== readSeq) return;
        set(() => ({
          sessionId,
          status: "error",
          error: message(reason),
          busy: false,
        }));
      });
  };

  const apply = async (
    sessionId: string,
    operation: CanvasOperation,
  ): Promise<boolean> => {
    const applyCanvas = port.applyCanvas;
    if (!applyCanvas) {
      set((current) => ({ ...current, error: "当前运行时不支持画布操作。" }));
      return false;
    }
    const mine = ++applySeq;
    set((current) => ({ ...current, busy: true, error: undefined }));
    try {
      const result = await applyCanvas({ sessionId, operation });
      if (mine !== applySeq) return false;
      set((current) => ({
        ...current,
        sessionId,
        document: result.document,
        status: "ready",
        busy: false,
        error: undefined,
      }));
      return true;
    } catch (reason: unknown) {
      if (mine !== applySeq) return false;
      // The stored document is still the last one this owner read, so the surface
      // drops its optimistic preview and reports the refusal instead of keeping it.
      set((current) => ({ ...current, busy: false, error: message(reason) }));
      return false;
    }
  };

  return {
    state: () => state,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    canRead: port.readCanvas !== undefined,
    canApply: port.applyCanvas !== undefined,
    read,
    apply,
    release,
    dispose: () => {
      listeners.clear();
    },
  };
}
