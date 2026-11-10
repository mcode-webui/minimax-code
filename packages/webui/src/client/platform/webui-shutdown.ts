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

/** The server refused the request, or the server could not be reached. */
export class WebuiShutdownRefused extends Error {
  override readonly name = "WebuiShutdownRefused";
}

export async function requestWebuiShutdown(
  options: WebuiShutdownOptions = {},
): Promise<void> {
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
  const response = await doFetch(
    `${target.origin}/webui-shutdown?${query.toString()}`,
    { method: "POST" },
  );
  if (!response.ok) {
    throw new WebuiShutdownRefused(
      response.status === 404
        ? "当前 WebUI 不支持关闭服务。"
        : `关闭服务失败（HTTP ${response.status}）。`,
    );
  }
}
