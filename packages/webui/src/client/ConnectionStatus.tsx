import type { ReactElement } from "react";
import { useSessionRuntimeState } from "./session-runtime-store.js";
import { useWebuiEventChannelDegraded } from "./connection-health.js";
import type { WebuiStreamState } from "./projection/stream-state.js";

/**
 * The three states a user can act on.
 *
 * Two signals feed this, and they are deliberately kept apart:
 *
 * - `projectWebuiConnectionState` still projects **only** the turn stream's own
 *   phase, which the reconnect paths in `stream.ts` and `SessionComposer.tsx`
 *   drive. It says nothing about a link that is not carrying a turn.
 * - `useWebuiEventChannelDegraded` is the **transport-level** signal, and it
 *   exists because the projection above cannot answer that question. The
 *   long-lived `watchEvents` socket marks itself healthy on an ack and degraded
 *   on `close`, and the component merges the two: failed beats reconnecting
 *   beats connected.
 *
 * What the channel signal does **not** cover, so nothing downstream over-trusts
 * it: the client sends no heartbeat on that socket, so detection is
 * close-edge only and a half-open link is invisible; and a watcher that was
 * never accepted stays "unknown" rather than degraded, so a host that is
 * already unreachable at load time reads as connected until something else
 * moves.
 */
export type WebuiConnectionState = "connected" | "reconnecting" | "failed";

/**
 * Projects the stream phase onto the connection state a user cares about.
 *
 * `reconnecting` is its own phase, so it maps straight across. `error` and
 * `refused` are the two terminal-failure phases the loop commits when it gives
 * up. Every other phase — `idle`, `streaming`, `waiting`, `done` — means the
 * client holds a working subscription, which is what "connected" means to
 * someone reading a status line.
 */
export function projectWebuiConnectionState(
  phase: WebuiStreamState["phase"],
): WebuiConnectionState {
  if (phase === "reconnecting") return "reconnecting";
  if (phase === "error" || phase === "refused") return "failed";
  return "connected";
}

const COPY: Readonly<
  Record<WebuiConnectionState, { readonly label: string; readonly detail: string; readonly tone: string }>
> = {
  connected: {
    label: "已连接",
    detail: "实时连接正常",
    tone: "text-text_default_secondary",
  },
  reconnecting: {
    label: "正在重连",
    detail: "连接中断，正在自动恢复",
    tone: "text-text_label_warning_secondary_default",
  },
  failed: {
    label: "连接失败",
    detail: "已停止接收更新",
    tone: "text-text_label_danger_secondary_default",
  },
};

export interface ConnectionStatusProps {
  /** Omitted on the home screen, which the store keys as its home runtime. */
  readonly sessionId?: string;
  readonly className?: string;
  /**
   * The host's layout call on whether a healthy connection earns a standing
   * line. The shell passes true: 已连接 is the state worth zero pixels, and
   * the region earns its place only when something needs the reader's
   * attention. Omitted, all three states render — the component itself stays
   * state-complete for any host that wants a permanent indicator.
   */
  readonly hideWhenConnected?: boolean;
  /**
   * Offers a manual retry from the failed state. The shell wires this to a
   * fresh stream-loop run anchored on the last cursor this client applied.
   * Omitted, no button renders — a host with no recovery path should not
   * offer one.
   */
  readonly onRetry?: () => void;
  /** The retry affordance's label, overridable the way the boundary's is. */
  readonly retryLabel?: string;
}

/**
 * Surfaces the user's connection state. Subscribes through
 * `useSessionRuntimeState` — the same hook the composer and shell already read —
 * rather than opening a second channel, so there is exactly one listener set
 * per session and no new reconnect state to keep in sync.
 *
 * The region renders in all three states and tags itself with
 * `data-connection-state`; whether a healthy connection should be visible or
 * collapsed is the host's layout call, not this component's.
 */
export function ConnectionStatus({
  sessionId,
  className,
  hideWhenConnected,
  onRetry,
  retryLabel = "重试连接",
}: ConnectionStatusProps): ReactElement | null {
  const { state } = useSessionRuntimeState(sessionId);
  // Two independent signals, merged: the selected session's stream phase (a
  // turn that failed mid-flight) and the event channel's health (the
  // always-on watcher, which is the only live link while the page is idle).
  // Either one saying "trouble" shows the region; a terminal stream failure
  // outranks a degraded-but-retrying channel.
  const streamConnection = projectWebuiConnectionState(state.stream.phase);
  const channelDegraded = useWebuiEventChannelDegraded();
  const connection =
    streamConnection === "failed"
      ? "failed"
      : streamConnection === "reconnecting" || channelDegraded
        ? "reconnecting"
        : "connected";
  if (hideWhenConnected && connection === "connected") return null;
  const copy = COPY[connection];
  // A failure usually carries the server's own reason (`refusal`), and `status`
  // is the looser status string. Both are preferred over the generic detail so
  // the user sees the actual cause, and the fallback keeps the region from
  // rendering an empty line when a phase failed without a recorded reason.
  const reason = state.stream.refusal ?? state.stream.status;
  return (
    <div
      role="status"
      aria-live="polite"
      data-testid="webui-connection-status"
      data-connection-state={connection}
      className={`flex items-center gap-spacing_8 text-size_12 ${copy.tone}${className ? ` ${className}` : ""}`}
    >
      <span data-testid="webui-connection-status-label">{copy.label}</span>
      <span data-testid="webui-connection-status-detail">{reason ?? copy.detail}</span>
      {/* Only the terminal state gets an affordance: `reconnecting` is the
       * automatic loop already mid-attempt, and a button there would race the
       * recovery it duplicates. */}
      {connection === "failed" && onRetry ? (
        <button
          type="button"
          data-testid="webui-connection-status-retry"
          className="webui-button-secondary"
          onClick={onRetry}
        >
          {retryLabel}
        </button>
      ) : null}
    </div>
  );
}