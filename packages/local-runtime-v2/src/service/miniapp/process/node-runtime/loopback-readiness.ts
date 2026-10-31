import { request as httpRequest } from 'node:http';

import { MINIAPP_LOOPBACK_HEALTH_PATH, MINIAPP_LOOPBACK_TOKEN_HEADER } from '../../contracts.js';
import { MiniAppNodeRuntimeError } from './node-runtime-startup-error.js';

export interface LoopbackReadinessInput {
  readonly port: number;
  /** The credential the runtime minted for this process generation. */
  readonly token: string;
  /** Absolute wall-clock deadline for readiness as a whole. */
  readonly deadline: number;
  readonly nowMs: () => number;
  readonly probeTimeoutMs: number;
  readonly retryMs: number;
  readonly wait: (ms: number, signal: AbortSignal) => Promise<void>;
  readonly signal: AbortSignal;
}

/**
 * Readiness for a Mini App's own server: an anonymous health request must be rejected with 401 and the
 * credentialed one answered 204 by the guard itself. A socket that merely accepts proves nothing,
 * because the port is derived from the plugin id and any local process can hold it.
 *
 * A port that answers wrongly is not retried — it keeps answering wrongly — only a failed connection is,
 * while the child is still binding.
 */
export async function waitForLoopbackReadiness(input: LoopbackReadinessInput): Promise<void> {
  let lastError: unknown;
  for (;;) {
    throwIfAborted(input.signal);
    try {
      await probeLoopbackAuth({
        port: input.port,
        timeoutMs: Math.min(input.probeTimeoutMs, remaining(input)),
        signal: input.signal,
        token: input.token,
      });
      return;
    } catch (error) {
      if (isProbeRejection(error)) throw error;
      lastError = error;
    }
    await input.wait(Math.min(input.retryMs, remaining(input)), input.signal);
    if (input.nowMs() >= input.deadline) {
      throw new MiniAppNodeRuntimeError('READINESS_TIMEOUT', 'Loopback readiness timed out', {
        cause: lastError,
      });
    }
  }
}

async function probeLoopbackAuth(input: {
  readonly port: number;
  readonly token: string;
  readonly timeoutMs: number;
  readonly signal: AbortSignal;
}): Promise<void> {
  const anonymous = await requestLoopbackHealth(input, undefined);
  if (anonymous !== 401) {
    throw new MiniAppNodeRuntimeError(
      'READINESS_PROBE_REJECTED',
      `unauthenticated health probe expected 401, received ${anonymous}`,
    );
  }
  const authenticated = await requestLoopbackHealth(input, input.token);
  if (authenticated !== 204) {
    throw new MiniAppNodeRuntimeError(
      'READINESS_PROBE_REJECTED',
      `authenticated health probe expected 204, received ${authenticated}`,
    );
  }
}

function isProbeRejection(error: unknown): boolean {
  return error instanceof MiniAppNodeRuntimeError && error.code === 'READINESS_PROBE_REJECTED';
}

function requestLoopbackHealth(
  input: {
    readonly port: number;
    readonly timeoutMs: number;
    readonly signal: AbortSignal;
  },
  token: string | undefined,
): Promise<number> {
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
        headers: token ? { [MINIAPP_LOOPBACK_TOKEN_HEADER]: token } : {},
      },
      (response) => {
        response.on('error', () => undefined);
        response.resume();
        finish({ status: response.statusCode ?? 0 });
      },
    );
    const onAbort = () => finish({ error: input.signal.reason });
    const timer = setTimeout(
      () =>
        finish({
          error: new MiniAppNodeRuntimeError(
            'READINESS_PROBE_TIMEOUT',
            'Loopback auth probe request timed out',
          ),
        }),
      Math.max(1, input.timeoutMs),
    );
    timer.unref();
    request.on('error', (error) => finish({ error }));
    input.signal.addEventListener('abort', onAbort, { once: true });
    request.end();
  });
}

function remaining(input: LoopbackReadinessInput): number {
  const value = input.deadline - input.nowMs();
  if (value <= 0) {
    throw new MiniAppNodeRuntimeError('READINESS_TIMEOUT', 'Readiness deadline expired');
  }
  return value;
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw signal.reason;
}
