/**
 * T4 — credential source for WS (re)connects.
 *
 * The WS ticket is one-shot and expires in 60s, so every connection attempt
 * (first connect AND every reconnect) needs a fresh one. There is no
 * dedicated ticket endpoint: a ticket is only produced by `GET /desktop/bindings`
 * while state=bound.
 *
 * CRITICAL: the main process CANNOT call `GET /desktop/bindings` successfully — that
 * request must carry the matrix gateway signature material (`yy`,
 * `x-signature`, public params) that only the renderer's axios pipeline
 * produces. So this provider NEVER hits the network. It only surfaces the
 * ticket bundle the renderer has already fetched and pushed down
 * (applyRendererCredentials → proxy.rendererCredentials, read live via the
 * injected `getRendererCache` getter). When there is no fresh bundle it
 * returns `stale`, and the owner drives the `rc:refresh-binding` reverse
 * loop to have the renderer re-sign (self-heal design §4.3).
 *
 * This module only CONSUMES tickets — it never sees or holds the user JWT,
 * and it never caches tickets (they are physically single-use).
 */
import type { RcCredentialProvider, RcCredentials } from "./types.js";

export interface RendererCredentialCache {
  bindingId: number;
  ticket: string;
  endpoint: string;
  fetchedAtMs: number;
}

const RENDERER_CACHE_MAX_AGE_MS = 60_000; // Tickets are valid for 60s anyway

/**
 * @param getRendererCache Live getter reading the proxy's current
 *   renderer-supplied bundle. A getter (not a snapshot) is required so that a
 *   credential refresh landing DURING an active connection's backoff is seen
 *   by the next `attempt()` — see design §4.3.
 */
export function createCredentialProvider(
  getRendererCache: () => RendererCredentialCache | null,
): RcCredentialProvider {
  return {
    async getCredentials(): Promise<RcCredentials> {
      const cache = getRendererCache();
      if (cache && Date.now() - cache.fetchedAtMs < RENDERER_CACHE_MAX_AGE_MS) {
        return {
          state: "bound",
          bindingId: cache.bindingId,
          ticket: cache.ticket,
          endpoint: cache.endpoint,
        };
      }
      // Missing / expired / already-consumed → owner must re-sign via renderer.
      return { state: "stale" };
    },
  };
}
