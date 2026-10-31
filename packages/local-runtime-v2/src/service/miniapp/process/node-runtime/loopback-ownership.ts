import { request as httpRequest } from 'node:http';

import { MINIAPP_LOOPBACK_HEALTH_PATH } from '../../contracts.js';

/**
 * What is holding a derived Mini App port.
 *
 * - `free` — nothing is listening; the port is this client's to take.
 * - `guarded` — a Mini App's own guard answered: another client is running this Mini App, or a
 *   previous generation of this one outlived its owner. Only the process that minted the credential
 *   can talk to it, so this client refuses rather than starting a second process over the same
 *   plugin data.
 * - `foreign` — something else holds the port and does not answer like the guard. Not this Mini App;
 *   the runtime may pick another port.
 * - `unknown` — the probe could not distinguish a listener from a free port; callers must fail
 *   closed rather than start on a different port.
 */
export type MiniAppPortOwnership = 'free' | 'guarded' | 'foreign' | 'unknown';

export interface MiniAppPortProbeInput {
  readonly port: number;
  readonly timeoutMs: number;
  readonly signal: AbortSignal;
}

/**
 * Probes a derived port before a Mini App is spawned. The shipped desktop client writes no ownership
 * record, so for anything already running this is the only signal there is, and it has to be the
 * guard's own answer rather than a bare connect: a socket that accepts proves nothing.
 */
export async function probeMiniAppPortOwnership(
  input: MiniAppPortProbeInput,
): Promise<MiniAppPortOwnership> {
  let status: number;
  try {
    status = await requestHealth(input);
  } catch (error) {
    if (input.signal.aborted) throw input.signal.reason;
    if (isConnectionRefused(error)) return 'free';
    return 'unknown';
  }
  return status === 401 ? 'guarded' : 'foreign';
}

function isConnectionRefused(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === 'ECONNREFUSED'
  );
}

function requestHealth(input: MiniAppPortProbeInput): Promise<number> {
  if (input.signal.aborted) return Promise.reject(input.signal.reason);
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (outcome: { readonly status: number } | { readonly error: unknown }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      input.signal.removeEventListener('abort', onAbort);
      if ('status' in outcome) {
        resolve(outcome.status);
        return;
      }
      request.destroy();
      reject(outcome.error);
    };
    const request = httpRequest(
      {
        host: '127.0.0.1',
        port: input.port,
        method: 'GET',
        path: MINIAPP_LOOPBACK_HEALTH_PATH,
        agent: false,
      },
      (response) => {
        response.on('error', () => undefined);
        response.resume();
        finish({ status: response.statusCode ?? 0 });
      },
    );
    const onAbort = () => finish({ error: input.signal.reason });
    const timer = setTimeout(
      () => finish({ error: new Error('Mini App port probe timed out') }),
      Math.max(1, input.timeoutMs),
    );
    timer.unref();
    request.on('error', (error) => finish({ error }));
    input.signal.addEventListener('abort', onAbort, { once: true });
    request.end();
  });
}
