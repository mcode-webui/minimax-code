// The 远程控制 projection.
//
// A pure function of the owner's snapshot and the clock: the copy the Desktop shows, in the
// Desktop's order, plus the live state (the pairing code and its countdown, the linked device,
// the pending unbind).
//
// The copy is transcribed from the Desktop's 远程控制 tab, measured on the live Desktop
// (its computed styles and rendered markup). It is kept here rather than in the
// component so a test can assert the page's wording without rendering it.
//
// ## The countdown
//
// The pairing code is good for a while and then it is not. The model therefore carries the
// seconds that are left, computed from the moment the code stops being valid, and the panel drops
// the code entirely once that moment has passed. A code shown as if it were live would send the
// user to the MiniMax App with a number the server no longer accepts.
import type {
  WebuiRemoteControlPendingUnbind,
  WebuiRemoteControlPhase,
  WebuiRemoteControlStatus,
} from "../../../../shared/contracts/remote-control.js";

export type WebuiRemoteControlOwnerStatus =
  /** Nothing read yet. */
  | "idle"
  /** A read is in flight. */
  | "loading"
  /** The link's state is known. */
  | "ready"
  /** This host cannot host a phone link. */
  | "unavailable"
  /** The last read failed. */
  | "error";

export interface WebuiRemoteControlSnapshot {
  readonly status: WebuiRemoteControlOwnerStatus;
  /** The bridge's own snapshot, when one was read. */
  readonly link?: WebuiRemoteControlStatus;
  /** The moment the pairing code stops being valid, when one is showing. */
  readonly pairingExpiresAtMs?: number;
  /** The producer-wide unbind waiting for the user's confirmation. */
  readonly pendingUnbind?: WebuiRemoteControlPendingUnbind;
  /** The failure that kept the page from reading the link. */
  readonly error?: string;
  readonly loadedAtMs?: number;
}

/** The hero title. */
export const WEBUI_REMOTE_CONTROL_TITLE = "用手机连接你的 MiniMax Code";
/** The line under the title. */
export const WEBUI_REMOTE_CONTROL_SUBTITLE = "通过 MiniMax App 访问此电脑，随时随地继续桌面端的任务";
/** The three feature rows, in the Desktop's order. */
export const WEBUI_REMOTE_CONTROL_FEATURES: readonly {
  readonly key: "takeover" | "continuous" | "anywhere";
  readonly text: string;
}[] = [
  { key: "takeover", text: "手机直接接管电脑上复杂任务，无需守在屏幕前。" },
  { key: "continuous", text: "对话不断线，进度、指令和审批，手机端随时处理。" },
  { key: "anywhere", text: "遛狗、散步、晒太阳，都可以是你的工作场景。" },
];
/** The button that starts the pairing flow. */
export const WEBUI_REMOTE_CONTROL_CONNECT_LABEL = "连接";
/** The SSH entry under the button. */
export const WEBUI_REMOTE_CONTROL_SSH_LABEL = "SSH";
/** The SSH entry's accessible name. */
export const WEBUI_REMOTE_CONTROL_SSH_ARIA_LABEL = "通过 SSH 连接远程服务器";
/** The two app-store marks under the card. */
export const WEBUI_REMOTE_CONTROL_PLATFORM_MARKS: readonly {
  readonly key: "android" | "ios";
  readonly label: string;
}[] = [
  { key: "android", label: "安卓" },
  { key: "ios", label: "iOS" },
];
/** The minimum app version, said twice on the Desktop: as the group's name and as the line. */
export const WEBUI_REMOTE_CONTROL_MINIMUM_VERSION = "支持移动端 App 4.15.0 及以上版本";

export interface WebuiRemoteControlPanelModel {
  readonly title: string;
  readonly subtitle: string;
  readonly features: readonly { readonly key: string; readonly text: string }[];
  readonly connectLabel: string;
  readonly sshLabel: string;
  readonly sshAriaLabel: string;
  readonly platformMarks: readonly { readonly key: string; readonly label: string }[];
  readonly minimumVersion: string;
  /** The bridge's phase, as the browser knows it. */
  readonly phase: WebuiRemoteControlPhase;
  /** The pairing code, while it is still valid. */
  readonly pairingCode?: string;
  /** The seconds the code is still good for. */
  readonly pairingExpiresInSeconds?: number;
  /** True once the code's moment has passed; the code is then not shown at all. */
  readonly pairingExpired: boolean;
  /** The linked device's name, when the host reports one. */
  readonly connectedDevice?: string;
  /** The failure the page shows above the card. */
  readonly error?: string;
  /** The producer-wide unbind waiting for the user's confirmation. */
  readonly pendingUnbind?: WebuiRemoteControlPendingUnbind;
  /** Whether the 连接 button is live. */
  readonly canConnect: boolean;
  /** Whether the page shows the linked device and the unbind action. */
  readonly showsConnectedDevice: boolean;
}

/**
 * The page's model.
 *
 * `nowMs` is a parameter, not a call to the clock: the countdown is the one thing on this page
 * that changes without the host saying anything, so a test has to be able to place it.
 */
export function webuiRemoteControlPanelModel(
  snapshot: WebuiRemoteControlSnapshot,
  nowMs: number,
): WebuiRemoteControlPanelModel {
  const link = snapshot.link;
  const phase = link?.phase ?? "idle";
  const expiresAtMs = snapshot.pairingExpiresAtMs;
  const pairingExpired =
    expiresAtMs !== undefined && nowMs >= expiresAtMs;
  const pairingExpiresInSeconds =
    expiresAtMs === undefined
      ? undefined
      : Math.max(0, Math.ceil((expiresAtMs - nowMs) / 1_000));
  // A code whose moment has passed is not shown: the user would type a number the server has
  // already forgotten.
  const pairingCode =
    phase === "pairing" && !pairingExpired && link?.pairingCode ? link.pairingCode : undefined;
  const connectedDevice =
    phase === "connected" || phase === "connecting" || phase === "reconnecting"
      ? (link?.displayName ?? link?.deviceName)
      : undefined;
  return {
    title: WEBUI_REMOTE_CONTROL_TITLE,
    subtitle: WEBUI_REMOTE_CONTROL_SUBTITLE,
    features: WEBUI_REMOTE_CONTROL_FEATURES,
    connectLabel: WEBUI_REMOTE_CONTROL_CONNECT_LABEL,
    sshLabel: WEBUI_REMOTE_CONTROL_SSH_LABEL,
    sshAriaLabel: WEBUI_REMOTE_CONTROL_SSH_ARIA_LABEL,
    platformMarks: WEBUI_REMOTE_CONTROL_PLATFORM_MARKS,
    minimumVersion: WEBUI_REMOTE_CONTROL_MINIMUM_VERSION,
    phase,
    ...(pairingCode === undefined ? {} : { pairingCode }),
    ...(pairingExpiresInSeconds === undefined ? {} : { pairingExpiresInSeconds }),
    pairingExpired,
    ...(connectedDevice === undefined ? {} : { connectedDevice }),
    ...(snapshot.error === undefined ? {} : { error: snapshot.error }),
    ...(snapshot.pendingUnbind === undefined ? {} : { pendingUnbind: snapshot.pendingUnbind }),
    canConnect: snapshot.status === "ready" || snapshot.status === "idle",
    showsConnectedDevice: phase === "connected" || phase === "connecting" || phase === "reconnecting",
  };
}
