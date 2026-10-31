// The remote-control business's transport seam.
//
// Nine members, and every one of them is optional on purpose: a build whose transport does not
// carry the 远程控制 surface leaves the member `undefined`, and the owner turns that into one
// stated refusal instead of a crash or a page that pretends the phone is not linked.
//
// The request and response types are the shared wire DTOs. This file may not name the bridge's
// own types — `shared/contracts/remote-control.ts` is what the browser is allowed to know, and the
// adapter behind the harness is where the conversion happens.
import type {
  WebuiRemoteControlComposerMode,
  WebuiRemoteControlConnectRequest,
  WebuiRemoteControlConnectResult,
  WebuiRemoteControlCredentials,
  WebuiRemoteControlDisconnectRequest,
  WebuiRemoteControlOperationResult,
  WebuiRemoteControlPendingUnbind,
  WebuiRemoteControlStatus,
} from "../../../../shared/contracts/remote-control.js";

export interface RemoteControlPort {
  /** The link's current state. */
  readonly getRemoteControlStatus?: () => Promise<WebuiRemoteControlStatus>;
  /**
   * The live state: the phase changes on the host, so it is pushed, not polled.
   *
   * A watch, not a promise of the server's envelope: the subscription outlives the render that
   * opened it, and detaching has to release the socket rather than merely stop reading it. The
   * returned function stops the watch.
   *
   * The frame arrives untyped: the wire carries whatever the host streamed, so the owner is the
   * place that decides what a frame is.
   */
  readonly watchRemoteControlStatus?: (
    onFrame: (frame: unknown) => void,
  ) => () => void;
  /** Opens the link: a pairing code, or the socket when a binding already exists. */
  readonly connectRemoteControl?: (
    request: WebuiRemoteControlConnectRequest,
  ) => Promise<WebuiRemoteControlConnectResult>;
  /** Closes the link, optionally dropping the phone binding with it. */
  readonly disconnectRemoteControl?: (
    request: WebuiRemoteControlDisconnectRequest,
  ) => Promise<WebuiRemoteControlOperationResult>;
  /** Pushes a signed one-shot ticket down to the service that holds the socket. */
  readonly applyRemoteControlCredentials?: (
    request: WebuiRemoteControlCredentials,
  ) => Promise<WebuiRemoteControlOperationResult>;
  /** Reports that the server no longer has a binding for this machine. */
  readonly reportRemoteControlBindingLost?: () => Promise<WebuiRemoteControlOperationResult>;
  /** The producer-wide unbind waiting for the user's confirmation. */
  readonly getRemoteControlPendingUnbind?: () => Promise<WebuiRemoteControlPendingUnbind | null>;
  /** Confirms or rejects that unbind. */
  readonly resolveRemoteControlUnbind?: (request: {
    readonly requestId: string;
    readonly confirmed: boolean;
  }) => Promise<WebuiRemoteControlOperationResult>;
  /** The composer mode the phone set on one session. */
  readonly publishRemoteControlComposerMode?: (
    request: WebuiRemoteControlComposerMode,
  ) => Promise<{ readonly accepted: boolean }>;
}
