// Event-channel connection health — the transport's always-on watcher,
// surfaced.
//
// The WebUI holds no single "connection" to lose: every request opens its own
// WebSocket. The one socket that IS long-lived is the `watchEvents`
// subscription — the shell keeps one from boot, and while no turn is running
// it is the only live link to the server. When it drops between turns, the
// session stream's phase stays `idle` (which the connection banner reads as
// "connected"), the transport's reconnect loop retries silently every 250ms,
// and the page shows nothing at all. That silent gap is what this module
// closes: `watchEvents` reports its socket's health here, and the banner
// merges the signal with the per-session stream phase.
//
// Aggregation rule — a watcher is *degraded* once it has been healthy and
// then went down, or once the channel has had no live link at all for longer
// than the startup grace.
//
// The "never accepted" case was unknown forever, and that is what left a host
// that is already unreachable at load time reading as connected: the stream
// phase stays `idle` ("connected") between turns, so nothing else moves.
// The grace is what keeps the boot shape quiet (a socket that is still
// opening must not flash 重连 on every page load) while giving the
// dead-backend shape a deadline.
//
// Two rules keep that deadline from misfiring:
//   * The grace only degrades the channel when NO watcher is healthy. With
//     several watchers mounted (the shell's plus the workspace panels'), a
//     healthy shell and one slow panel must not read as a dead channel — the
//     channel HAS a live link, so it is not degraded.
//   * The grace is long enough to cover the transport's reconnect attempts
//     (250ms base with 0.5-1.0x jitter, several tries) on a cold backend.
//     A backend that needs longer than that is not "still booting", it is
//     unreachable — but a short grace would cry wolf on a merely slow one.
//
// A watcher that IS accepted clears its own grace, and the timer never
// outlives the watcher it watches. The transport owns the reporting, so
// every current and future `watchEvents` caller is covered without each of
// them wiring callbacks.
//
// This module is framework-free. The React subscription lives in
// `bindings/use-connection-health.ts`.

interface WebuiWatcherHealth {
  readonly token: number;
  healthy: boolean;
  everHealthy: boolean;
  /** The startup grace ran out while this watcher was still unaccepted. */
  startupExpired: boolean;
  graceTimer?: ReturnType<typeof setTimeout>;
}

/** How long the channel may have no live link before it reads as degraded.
 *  Comfortably longer than the transport's reconnect attempts on a cold
 *  backend (250ms base, 0.5-1.0x jitter, several tries), so a slow start is
 *  not mistaken for an unreachable host. */
const STARTUP_GRACE_MS = 30_000;

const watchers = new Map<number, WebuiWatcherHealth>();
const listeners = new Set<() => void>();
let nextToken = 0;

/** Whether any watcher currently holds a live link. */
function anyHealthy(): boolean {
  for (const watcher of watchers.values()) if (watcher.healthy) return true;
  return false;
}

function degraded(): boolean {
  // A watcher that held a link and lost it degrades the channel on its own.
  for (const watcher of watchers.values())
    if (watcher.everHealthy && !watcher.healthy) return true;
  // The startup deadline only speaks when the channel has no live link at
  // all: a healthy shell with one slow panel is not a dead channel.
  if (anyHealthy()) return false;
  for (const watcher of watchers.values()) if (watcher.startupExpired) return true;
  return false;
}

function notifyIfChanged(before: boolean): void {
  if (degraded() !== before) for (const listener of listeners) listener();
}

/** Node's timer exposes `unref`; the DOM lib types `setTimeout` as returning
 *  a plain number, so the capability is read through a narrow cast rather
 *  than assumed on the type. Exported because the event channel's liveness
 *  probe schedules the same kind of don't-hold-the-process timers. */
export function unrefTimer(timer: ReturnType<typeof setTimeout>): void {
  (timer as { unref?: () => void }).unref?.();
}

/** Registers one `watchEvents` subscription. Called by the transport only. */
export function registerWebuiEventWatcher(): number {
  nextToken += 1;
  const watcher: WebuiWatcherHealth = {
    token: nextToken,
    healthy: false,
    everHealthy: false,
    startupExpired: false,
  };
  watchers.set(nextToken, watcher);
  // The deadline on the unknown state. The transport reuses one token across
  // reconnects, so the timer is set once per subscription and is NOT reset by
  // a retry — a backend that never comes up expires it whatever the retry
  // count. `unref` keeps the timer from holding a process (or a test worker)
  // open on its own.
  watcher.graceTimer = setTimeout(() => {
    watcher.graceTimer = undefined;
    if (watcher.healthy) return;
    const before = degraded();
    watcher.startupExpired = true;
    if (degraded() !== before) for (const listener of listeners) listener();
  }, STARTUP_GRACE_MS);
  unrefTimer(watcher.graceTimer);
  return nextToken;
}

/** Ends the startup grace for one watcher now, ahead of the timer.
 *
 *  Called by the channel's fatal path: a fatal rejection that arrives while
 *  the subscription is still unaccepted has already decided the link will
 *  never come up on its own, so waiting out the grace would only extend the
 *  silent "connected" window on top of a settled fact. The body mirrors the
 *  timer's exactly — clear the timer, keep an accepted watcher untouched
 *  (this is a pure no-op for it, listeners included), flip `startupExpired`
 *  on the unaccepted one — so the two paths cannot drift apart. */
export function expireWebuiEventWatcherGrace(token: number): void {
  const watcher = watchers.get(token);
  if (!watcher) return;
  if (watcher.graceTimer !== undefined) {
    clearTimeout(watcher.graceTimer);
    watcher.graceTimer = undefined;
  }
  if (watcher.healthy) return;
  const before = degraded();
  watcher.startupExpired = true;
  notifyIfChanged(before);
}

/** The watcher's `watchEvents` request was accepted — its socket is live. */
export function markWebuiEventWatcherHealthy(token: number): void {
  const watcher = watchers.get(token);
  if (!watcher) return;
  const before = degraded();
  // Accepted: the grace no longer applies to this watcher.
  if (watcher.graceTimer !== undefined) {
    clearTimeout(watcher.graceTimer);
    watcher.graceTimer = undefined;
  }
  watcher.healthy = true;
  watcher.everHealthy = true;
  notifyIfChanged(before);
}

/** The watcher's socket closed — it will reconnect on the transport's own loop. */
export function markWebuiEventWatcherDown(token: number): void {
  const watcher = watchers.get(token);
  if (!watcher) return;
  const before = degraded();
  watcher.healthy = false;
  notifyIfChanged(before);
}

/** The subscription unsubscribed (component unmounted); it no longer counts. */
export function unregisterWebuiEventWatcher(token: number): void {
  const watcher = watchers.get(token);
  if (watcher?.graceTimer !== undefined) clearTimeout(watcher.graceTimer);
  const before = degraded();
  watchers.delete(token);
  notifyIfChanged(before);
}

/**
 * Whether the event channel has lost a link it previously held. Read
 * imperatively only for assertions; React reads it through the binding.
 */
export function isWebuiEventChannelDegraded(): boolean {
  return degraded();
}

/** Subscribe to changes of the degraded fact. Returns a detach. */
export function subscribeWebuiConnectionHealth(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
