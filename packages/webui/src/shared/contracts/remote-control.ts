// Wire contract record: every exported
// declaration below records its wire purpose, its producer and its
// consumers, verified against the tree. Documentation only.
//
// | Declaration | Wire purpose | Producer | Consumers |
// | --- | --- | --- | --- |
// | `WebuiRemoteControlPhase` | Where the phone link stands right now. | Remote-control bridge `RCStatus.phase` (via `runtime/harness/remote-control.ts`). | `runtime/harness/remote-control.ts`; the 远程控制 tab. |
// | `WebuiRemoteControlStatus` | The bridge's status snapshot, as the pairing page reads it. | Remote-control bridge `getStatus()`. | `runtime/harness/remote-control.ts`; the 远程控制 tab. |
// | `WebuiRemoteControlConnectRequest` | How the phone link should be opened. | The 远程控制 tab's 连接 button. | `runtime/harness/remote-control.ts`. |
// | `WebuiRemoteControlConnectResult` | The outcome of opening the phone link. | Remote-control bridge `connect()`. | `runtime/harness/remote-control.ts`; the 远程控制 tab. |
// | `WebuiRemoteControlDisconnectRequest` | Whether disconnecting also unbinds the phone. | The 远程控制 tab's disconnect action. | `runtime/harness/remote-control.ts`. |
// | `WebuiRemoteControlOperationResult` | Outcome of a bridge mutation that has no payload. | Remote-control bridge mutations. | `runtime/harness/remote-control.ts`; the 远程控制 tab. |
// | `WebuiRemoteControlPendingUnbind` | The pending producer-wide unbind the user must confirm. | Remote-control bridge `getPendingProducerUnbind()`. | `runtime/harness/remote-control.ts`; the 远程控制 tab. |
// | `WebuiRemoteControlCredentials` | The one-shot binding ticket the browser signed and pushed down. | The browser's own binding pipeline. | `runtime/harness/remote-control.ts`. |
// | `WebuiRemoteControlComposerMode` | The composer mode the phone set on a session. | The 远程控制 tab's session mode switch. | `runtime/harness/remote-control.ts`. |
//
// The bridge's own types (`RCStatus`, `RCConnectResult`, `RcPendingUnbind`, …) live in the
// `@mavis/remote-control-bridge` package and stay out of `src/shared`: the browser is allowed to
// know the phase, the pairing code and the expiry — not the bridge's internal epochs.

/**
 * Where the phone link stands.
 *
 * The phase vocabulary is the bridge's own (`RCPhase`): `idle` → `pairing` → `connecting` →
 * `connected`, with `reconnecting` while a dropped socket backs off, `error` after a failure and
 * `unbound` once the user unlinks the phone.
 */
export type WebuiRemoteControlPhase =
  | "idle"
  | "pairing"
  | "connecting"
  | "connected"
  | "reconnecting"
  | "error"
  | "unbound";

export interface WebuiRemoteControlStatus {
  readonly phase: WebuiRemoteControlPhase;
  readonly bindingId?: number;
  /** The phone's display name, when the server reports one. */
  readonly displayName?: string;
  /** Present while `phase` is `pairing`: the code the user types into the MiniMax App. */
  readonly pairingCode?: string;
  /** Seconds the pairing code stays valid. */
  readonly expiresIn?: number;
  readonly lastError?: { readonly code: string; readonly message: string };
  /** Set while a producer-wide unbind is waiting for the user's confirmation. */
  readonly pendingUnbindRequestId?: string;
  /** This machine's stable device id, as Desktop's pairing page shows it. */
  readonly deviceId?: string;
  /** This machine's host name, as Desktop's pairing page shows it. */
  readonly deviceName?: string;
}

export interface WebuiRemoteControlConnectRequest {
  /**
   * Ask for a fresh pairing code even when a link already exists.
   *
   * Desktop's 连接 button always re-arms the pairing flow, so the pairing page can re-pair a
   * second phone without an unbind first.
   */
  readonly requestCode?: boolean;
}

export interface WebuiRemoteControlConnectResult {
  readonly phase: WebuiRemoteControlPhase;
  readonly pairingCode?: string;
  readonly expiresIn?: number;
  readonly error?: string;
}

export interface WebuiRemoteControlDisconnectRequest {
  /** Also drop the phone binding, not just the socket. */
  readonly unbind?: boolean;
}

export interface WebuiRemoteControlOperationResult {
  readonly success: boolean;
  readonly error?: string;
}

/** A producer-wide unbind waiting for the user's confirmation. */
export interface WebuiRemoteControlPendingUnbind {
  readonly requestId: string;
  readonly createdAtMs: number;
  readonly attempts: number;
  readonly bindingId?: number;
}

/**
 * The one-shot ticket bundle the browser signed and pushed to the service.
 *
 * Desktop's renderer owns the binding HTTP pipeline (only its axios can sign
 * `GET /desktop/bindings`), then hands the fresh ticket to the main process over
 * `rc:binding-ready`. The WebUI keeps that split: the browser signs, the service holds the socket.
 */
export interface WebuiRemoteControlCredentials {
  readonly bindingId: number;
  readonly ticket: string;
  readonly endpoint: string;
  readonly producerGeneration?: number;
  readonly requestEpoch?: number;
}

/** The composer mode the phone set on one session. */
export interface WebuiRemoteControlComposerMode {
  readonly sessionId: string;
  readonly mode: "default" | "goal" | "plan";
}

/**
 * One frame of the remote-control stream.
 *
 * The phone link changes on the host, not in the browser: the pairing code expires, the socket
 * drops, the phone asks a permission question. Desktop pushes each change to the renderer; the
 * WebUI pushes them down one stream instead, so the pairing page reflects the live phase without
 * polling.
 */
export type WebuiRemoteControlEvent =
  | { readonly type: "status"; readonly status: WebuiRemoteControlStatus }
  | { readonly type: "composer-mode"; readonly composerMode: WebuiRemoteControlComposerMode }
  | {
      readonly type: "permission";
      readonly permission: {
        readonly requestId: string;
        readonly sessionId?: string;
        readonly toolName?: string;
      };
    };

/**
 * The result envelope of the remote-control stream.
 *
 * Same shape as the session event channel (`WebuiWatchEventsResult`): a source of frames, or a
 * structured refusal when this host cannot host the phone link.
 */
export type WebuiWatchRemoteControlResult =
  | {
      readonly ok: true;
      readonly source:
        | AsyncIterable<WebuiRemoteControlEvent>
        | Iterable<WebuiRemoteControlEvent>;
    }
  | {
      readonly ok: false;
      readonly status: number;
      readonly body: {
        readonly key?: string;
        readonly message: string;
        readonly detail?: string;
      };
    };
