// Asking the local WebUI server to stop.
//
// Responsibility: this is **browser infrastructure IO**. It posts the request
// the shutdown route answers and reports what the server said; it decides
// nothing about the user's intent -- the confirmation that precedes it lives
// with the menu that offers it.
//
// The origin and the token are the ones the transfer routes use: both are
// served by the same listener the socket was opened against, so the answer is
// read from the injected runtime config rather than restated here.

import { readWebuiSessionTransferTarget } from "./session-transfer-target.js";

export interface WebuiShutdownOptions {
  /** Injected in tests; defaults to the global fetch. */
  readonly fetchImpl?: typeof fetch;
  readonly origin?: string;
  readonly token?: string;
}

/**
 * What the request found.
 *
 * - `stopping` -- the service took the request and is on its way down.
 * - `gone` -- nothing is listening any more: the service is not running.
 * - `still-running` -- the request got no answer, but the service is still
 *   there and still answering.
 *
 * The last two are the same question asked twice. Asking a service that is
 * already down to stop is not a failure, and a request that never reached a
 * service that is still up is not a success either; which of the two happened
 * is what the person needs to be told.
 */
export type WebuiShutdownState = "stopping" | "gone" | "still-running";

/** The server answered, and it refused. */
export class WebuiShutdownRefused extends Error {
  override readonly name = "WebuiShutdownRefused";
}

export async function requestWebuiShutdown(
  options: WebuiShutdownOptions = {},
): Promise<WebuiShutdownState> {
  // Presence is checked, not truthiness: an injected empty token is a valid
  // dev target, and falling back to the global for it would silently ignore
  // the caller's origin.
  const target =
    options.origin !== undefined && options.token !== undefined
      ? { origin: options.origin, token: options.token }
      : readWebuiSessionTransferTarget();
  if (!target) {
    throw new WebuiShutdownRefused("当前 WebUI 未连接运行时，无法关闭服务。");
  }

  const query = new URLSearchParams({ token: target.token });
  const doFetch = options.fetchImpl ?? globalThis.fetch;
  let response: Response;
  try {
    response = await doFetch(
      `${target.origin}/webui-shutdown?${query.toString()}`,
      { method: "POST" },
    );
  } catch {
    // The request got no answer. That is what a service that is already
    // down looks like, and it is also what a service that went down before
    // its answer arrived looks like: the answer and the teardown race, and
    // a browser that reads the answer late loses that race. A second
    // question settles which of the two it was -- the listener that is
    // still there answers, the one that is gone does not.
    return (await isListening(target.origin, doFetch))
      ? "still-running"
      : "gone";
  }
  if (!response.ok) {
    throw new WebuiShutdownRefused(
      response.status === 404
        ? "当前 WebUI 不支持关闭服务。"
        : `关闭服务失败（HTTP ${response.status}）。`,
    );
  }
  return "stopping";
}

/**
 * Whether the service still answers on that address.
 *
 * Any HTTP answer counts, including a refusal: the question is whether the
 * listener is there, and a listener that refuses is still a listener. A HEAD
 * keeps the answer empty.
 */
async function isListening(
  origin: string,
  doFetch: typeof fetch,
): Promise<boolean> {
  try {
    await doFetch(`${origin}/`, { method: "HEAD", cache: "no-store" });
    return true;
  } catch {
    return false;
  }
}
