// Event-channel connection health — the transport's always-on watcher,
// surfaced. (Plan §7.2 `client/infrastructure/connection-health.ts`: the fact
// is recorded here, with no React.)
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
// then went down, or once the startup grace ran out without it ever being
// accepted. The grace exists because of the boot shape the original rule was
// protecting: a watcher that has not been accepted *yet* is "unknown", not
// degraded, so a page that is still loading never flashes a reconnecting
// banner. But "unknown" used to last forever, and a page whose backend was
// already unreachable when it loaded stayed completely silent — the banner
// read the stream phase (`idle` = connected) and nothing else was watching.
// So the unknown state now has a deadline: a watcher still unaccepted after
// `STARTUP_GRACE_MS` degrades the channel, because at that point the honest
// statement is "this link is not coming up", not "we are still booting".
// With several watchers mounted (the shell's plus the workspace panels'), any
// once-healthy watcher being down — or any watcher past its grace — degrades
// the channel; the transport owns the reporting, so every current and future
// `watchEvents` caller is covered without each of them wiring callbacks.
//
// This module is framework-free. The React subscription lives in
// `client/bindings/use-connection-health.ts`.

interface WebuiWatcherHealth {
  readonly token: number;
  healthy: boolean;
  everHealthy: boolean;
  /** The startup grace ran out while the watcher was still unaccepted. */
  startupExpired: boolean;
  graceTimer?: ReturnType<typeof setTimeout>;
}

/** How long a freshly registered watcher may stay unaccepted before the
 *  channel is declared degraded. Generous next to the transport's 250ms
 *  reconnect loop and a local WebSocket handshake, and far below the point
 *  where a user concludes the page is simply dead. */
const STARTUP_GRACE_MS = 10_000;

const watchers = new Map<number, WebuiWatcherHealth>();
const listeners = new Set<() => void>();
let nextToken = 0;

function degraded(): boolean {
  for (const watcher of watchers.values())
    if (!watcher.healthy && (watcher.everHealthy || watcher.startupExpired)) return true;
  return false;
}

function notifyIfChanged(before: boolean): void {
  if (degraded() !== before) for (const listener of listeners) listener();
}

/** Node's timer exposes `unref`; the DOM lib types `setTimeout` as returning
 *  a plain number, so the capability is read through a narrow cast rather
 *  than assumed on the type. */
function unrefTimer(timer: ReturnType<typeof setTimeout>): void {
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
  // The unknown state's deadline. `unref` where the host offers it so the
  // timer never holds a process (or a test worker) open on its own.
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

/** The watcher's `watchEvents` request was accepted — its socket is live. */
export function markWebuiEventWatcherHealthy(token: number): void {
  const watcher = watchers.get(token);
  if (!watcher) return;
  const before = degraded();
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
