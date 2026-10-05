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
// Aggregation rule — a watcher is *degraded* only once it has been healthy
// and then went down. A watcher that has never been accepted (boot in
// progress, or a host that never answers events) is "unknown", not degraded:
// flagging it would flash 重连 at every page load, and the honest statement
// about a link that never existed is nothing, not "reconnecting". With
// several watchers mounted (the shell's plus the workspace panels'), any
// once-healthy watcher being down degrades the channel; the transport owns
// the reporting, so every current and future `watchEvents` caller is covered
// without each of them wiring callbacks.

import { useEffect, useState } from "react";

interface WebuiWatcherHealth {
  readonly token: number;
  healthy: boolean;
  everHealthy: boolean;
}

const watchers = new Map<number, WebuiWatcherHealth>();
const listeners = new Set<() => void>();
let nextToken = 0;

function degraded(): boolean {
  for (const watcher of watchers.values())
    if (watcher.everHealthy && !watcher.healthy) return true;
  return false;
}

function notifyIfChanged(before: boolean): void {
  if (degraded() !== before) for (const listener of listeners) listener();
}

/** Registers one `watchEvents` subscription. Called by the transport only. */
export function registerWebuiEventWatcher(): number {
  nextToken += 1;
  watchers.set(nextToken, { token: nextToken, healthy: false, everHealthy: false });
  return nextToken;
}

/** The watcher's `watchEvents` request was accepted — its socket is live. */
export function markWebuiEventWatcherHealthy(token: number): void {
  const watcher = watchers.get(token);
  if (!watcher) return;
  const before = degraded();
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
  const before = degraded();
  watchers.delete(token);
  notifyIfChanged(before);
}

/**
 * Whether the event channel has lost a link it previously held. Subscribe
 * through the hook; read imperatively only for assertions in tests.
 */
export function isWebuiEventChannelDegraded(): boolean {
  return degraded();
}

export function useWebuiEventChannelDegraded(): boolean {
  const [value, setValue] = useState(degraded);
  useEffect(() => {
    setValue(degraded());
    const listener = () => setValue(degraded());
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }, []);
  return value;
}
