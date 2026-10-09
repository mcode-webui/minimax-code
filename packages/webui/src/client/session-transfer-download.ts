// Session export — ask the server for one session as a transfer file.
//
// Responsibility (plan §7.2 `client/infrastructure/session-transfer-download.ts`;
// ticket #51): this is **browser download IO**. It resolves the transfer target
// and hands a URL to the browser to navigate to; it decides nothing about which
// session may be exported. That business decision and the rail's export request
// live in `application/session-workflows.ts`, and the composition root supplies
// this adapter — it is never absorbed into a business workflow module.
//
// `GET /session-transfer` writes a `mcode-webui-session-transfer@1` file: the
// canonical layer the model reads on the next turn, the display layer the user
// reads, and -- for a session that has ever been compacted -- the whole
// snapshot lineage the import scanner walks before it will accept anything.
// That file is exactly what `POST /session-import` takes back.
//
// This used to be assembled in the browser out of `loadMessages` pages under
// the tag `mcode-webui-session@1`. That file could not come back:
// `assertWebuiTransferFile` refuses that tag by name, because it carries the
// display layer only, and replaying it would produce a session the user can
// read but the model cannot -- worse than a refusal, because it looks like it
// worked. The export half and the import half were written by different
// commits and never met: the round trip was closed on the server and open in
// the rail. A user who exported a session and picked the file back got
// "这是旧版导出的会话文件…无法还原" for a file this UI had just written.
//
// The download is a navigation, not a `fetch` followed by `blob()`. A real
// session on this machine exports to tens of megabytes, and holding that in
// the JS heap only to hand it straight back to the browser is the difference
// between a download and a tab that eats the machine. The route already sets
// `Content-Disposition: attachment`, so the browser streams it to disk under
// the filename the server chose.
//
// The cost of that choice is error reporting. A `fetch` could read a 404 and
// raise a message; a navigation cannot, and a failed export shows up as a
// small downloaded body instead of an error on the page. That is the right
// trade for a 40 MB file, and it is a trade, so it is written down.

import {
  readWebuiSessionTransferTarget,
  type WebuiSessionTransferTarget,
} from "./session-transfer-target.js";

/** No runtime attached, so there is no server to ask for the file. */
export class WebuiSessionExportUnavailable extends Error {
  override readonly name = "WebuiSessionExportUnavailable";
  constructor(message = "当前 WebUI 未连接运行时，无法导出会话。") {
    super(message);
  }
}

export interface WebuiSessionTransferDownloadOptions {
  /** Injected in tests; defaults to the configured runtime. */
  readonly target?: WebuiSessionTransferTarget;
  /** Injected in tests; defaults to the global `location`. */
  readonly locationImpl?: { assign(url: string): void };
}

/**
 * The session id goes in the query string, not the path, and the token beside
 * it -- the transport is a websocket with no per-request header channel, and
 * the credential check on these routes reads the query.
 */
export function buildWebuiSessionTransferUrl(
  sessionId: string,
  target: WebuiSessionTransferTarget,
): string {
  const query = new URLSearchParams({ token: target.token, sessionId });
  return `${target.origin}/session-transfer?${query.toString()}`;
}

/**
 * Hand the URL to the browser. Returns it so the caller can log or test
 * against exactly what was navigated to.
 */
export function startWebuiSessionTransferDownload(
  sessionId: string,
  options: WebuiSessionTransferDownloadOptions = {},
): string {
  const target = options.target ?? readWebuiSessionTransferTarget();
  if (!target) throw new WebuiSessionExportUnavailable();
  const url = buildWebuiSessionTransferUrl(sessionId, target);
  const location = options.locationImpl ?? (globalThis as { location?: { assign(url: string): void } }).location;
  if (!location) throw new WebuiSessionExportUnavailable("当前环境没有可用的地址栏，无法触发下载。");
  location.assign(url);
  return url;
}
