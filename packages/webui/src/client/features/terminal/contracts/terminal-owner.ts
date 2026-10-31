// The Terminal business's published surface.
//
// These declarations are what a peer business — the workspace panel today —
// consumes: the owner interface and the catalogue it answers with. The
// implementation (`createWebuiTerminalOwner`) and its policy stay in
// `../application/terminal-owner.js`; a peer needs to *drive* a terminal and to
// render its catalogue, not to build the owner.

/**
 * What this client can do with terminals, and *why* not when it cannot.
 *
 * `absent` and `incompatible` are different failures with different fixes. An
 * absent bridge means this host has no terminal service at all — nothing is
 * broken and nothing should be retried. An incompatible one means the service is
 * there and speaks a different protocol, so the calls this client makes will be
 * refused. Collapsing both into a single `false` left a host with a real
 * mismatch looking like a host with no terminals, which is exactly the "a stub
 * that looks supported" reading the plan rejected.
 */
export type WebuiTerminalSupport =
  /** The operation is wired and has been called successfully at least once. */
  | "supported"
  /** This host does not provide the operation. Nothing to retry. */
  | "absent"
  /**
   * The host has the bridge and a companion it needs is missing, so the surface
   * is real and will not work yet. Distinct from `absent` on purpose: one is a
   * feature the deployment does not have, the other is a feature that is not
   * finished starting, and a surface says different things about them.
   */
  | "not-ready"
  /**
   * No manifest arrived, so nothing declared this family either way.
   *
   * The attempt is still allowed — an older service is not an absent one — but the
   * state is not `supported`: nothing has established that it works, and calling it
   * supported is how a control gets offered on the strength of a browser stub.
   */
  | "unverified"
  /**
   * The host provides a terminal service that refused this client's request.
   * The roster keeps listing; the operations this client needs are unavailable
   * until the versions agree.
   */
  | "incompatible";

/** One terminal this client knows about, as the process half reports it. */
export interface WebuiTerminalRecord {
  readonly terminalId: string;
  readonly status: string;
  readonly output?: string;
  readonly workspaceTabId?: string;
}

export interface WebuiTerminalCatalogue {
  readonly terminals: readonly WebuiTerminalRecord[];
  readonly loading: boolean;
  readonly error?: string;
}

/**
 * The terminal bridge's reachability, as the owner has observed it.
 *
 * Derived from what the port actually did rather than declared up front, because
 * only a call can tell an incompatible service from a missing one.
 */
export interface WebuiTerminalSupportReport {
  readonly create: WebuiTerminalSupport;
  readonly list: WebuiTerminalSupport;
  readonly write: WebuiTerminalSupport;
  readonly resize: WebuiTerminalSupport;
  readonly dispose: WebuiTerminalSupport;
  readonly watch: WebuiTerminalSupport;
}

/** The state before anyone has asked the runtime anything. */
export const initialWebuiTerminalCatalogue: WebuiTerminalCatalogue = {
  terminals: [],
  loading: false,
};

export interface WebuiTerminalOwner {
  readonly getSnapshot: () => WebuiTerminalCatalogue;
  readonly subscribe: (listener: () => void) => () => void;

  /**
   * "May I", read live rather than snapshotted at construction. A flag frozen at
   * construction reports what the port declared; a flag frozen after the first
   * refusal reports a capability the host does not actually have. Read it as a
   * getter so a refused call is visible to the panel that asked.
   */
  readonly canCreate: boolean;
  readonly canWrite: boolean;
  readonly canResize: boolean;
  readonly canDispose: boolean;
  readonly canWatch: boolean;

  /**
   * Why each operation is or is not available, as observed rather than declared.
   * The `can*` flags above answer "may I"; this answers "and if not, is there
   * something to fix" — which is the difference between a host with no terminal
   * service and a host whose terminal service this client cannot talk to.
   */
  readonly support: () => WebuiTerminalSupportReport;

  /** Read the catalogue; a failure is recorded in the snapshot, not thrown. */
  readonly refresh: () => Promise<void>;
  /** Create a terminal and adopt it into the catalogue. */
  readonly create: (workspaceDir: string, size?: { readonly cols: number; readonly rows: number }, workspaceTabId?: string) => Promise<WebuiTerminalRecord | undefined>;
  readonly write: (terminalId: string, data: string) => Promise<void>;
  readonly resize: (request: WebuiTerminalSizeRequest) => Promise<void>;
  /** Explicit process death. A view release never calls this. */
  readonly disposeProcess: (terminalId: string) => Promise<void>;
  /**
   * Watch one terminal's frames. The returned disposer releases exactly that
   * watch — it does not stop the process, which is the whole point of the split.
   */
  readonly attach: (
    terminalId: string,
    onFrame: (frame: WebuiTerminalFrameView) => void,
  ) => () => void;
  /** Release every watch (a view going away). Processes stay alive. */
  readonly detachAll: () => void;
  /**
   * Fence the page's observation and nothing else: every watch is released and
   * the owner stops publishing. Processes are **not** touched — a terminal this
   * page merely listed belongs to the service, and an explicit `disposeProcess`
   * or the service's own shutdown is the only thing that ends a process.
   *
   * Synchronous on purpose: a page teardown installs its fence before any
   * asynchronous cleanup, so a create that resolves afterwards cannot repopulate
   * a dead page's catalogue or reattach its watch.
   */
  readonly dispose: () => void;
}

/** The resize request the owner forwards, named here so peers need one import. */
export interface WebuiTerminalSizeRequest {
  readonly terminalId: string;
  readonly cols: number;
  readonly rows: number;
}

/** One terminal frame, named here for the same reason. */
export interface WebuiTerminalFrameView {
  readonly terminalId: string;
  readonly data: string;
  readonly exited: boolean;
}
