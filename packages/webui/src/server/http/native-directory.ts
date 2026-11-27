// Desktop capability supplied only by an interactive local launcher. General
// WebUI credentials alone never authorize opening native desktop UI.
import type { IncomingMessage, ServerResponse } from "node:http";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { credentialFromCookie, credentialPresented, type WebuiCredential } from "../credentials.js";
import { stat } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { rejectHttp } from "./responses.js";

export interface WebuiNativeDirectoryPicker {
  readonly grant: string;
  /** Abort must close the owned dialog and settle after its process exits. */
  choose(signal: AbortSignal): Promise<{ readonly kind: "selected"; readonly directory: string } | { readonly kind: "cancelled" }>;
  dispose(): Promise<void>;
}
interface Admission {
  readonly host: string;
  readonly port?: number;
  readonly fullAccess?: boolean;
  readonly credential: WebuiCredential;
}
const loopback = (value: string | undefined) => value === "127.0.0.1" || value === "::1" || value === "::ffff:127.0.0.1";
function equalSecret(value: string | string[] | undefined, expected: string): boolean {
  if (typeof value !== "string" || !expected) return false;
  const a = Buffer.from(value); const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}
/** Same absolute/existing-directory semantics as the operation validator,
 * but never block the HTTP event loop on a disconnected Windows share. The OS
 * stat itself is not cancellable; its late result is ignored after the bound. */
export async function validateNativeDirectory(
  directory: string,
  timeoutMs = 3_000,
  inspect: (path: string) => Promise<{ isDirectory(): boolean }> = stat,
): Promise<boolean> {
  if (typeof directory !== "string" || !isAbsolute(directory)) return false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      Promise.resolve().then(() => inspect(directory)).then(value => value.isDirectory(), () => false),
      new Promise<false>(resolve => { timer = setTimeout(() => resolve(false), timeoutMs); }),
    ]);
  } finally { clearTimeout(timer); }
}
export function createNativeDirectoryRoute(picker: WebuiNativeDirectoryPicker, timeoutMs = 120_000) {
  let active: { controller: AbortController; settled: Promise<unknown> } | undefined;
  let pairing: { browserKey: string; cookieToken: string } | undefined;
  let closed = false;
  return {
    async handle(request: IncomingMessage, response: ServerResponse, context: Admission, action: "choose" | "authorize" = "choose"): Promise<void> {
      response.setHeader("Cache-Control", "no-store");
      const authority = context.host === "::1" ? `[::1]:${context.port}` : `${context.host}:${context.port}`;
      if (closed || context.fullAccess || !loopback(context.host) || !loopback(request.socket.remoteAddress) ||
          !context.port || request.headers.host !== authority || request.headers.origin !== `http://${authority}` ||
          request.headers["sec-fetch-site"] !== "same-origin" ||
          Object.keys(request.headers).some((key) => key === "forwarded" || key.startsWith("x-forwarded-"))) {
        rejectHttp(response, 403, "Native directory selection unavailable"); return;
      }
      const cookieName = `webui_native_directory_${context.port}`;
      if (!equalSecret(request.headers["x-webui-native-grant"], picker.grant)) {
        const cookie = credentialFromCookie(request.headers.cookie, cookieName);
        // Cookies follow a host across ports. The second proof belongs to the exact browser origin.
        if (action === "authorize" || !pairing || cookie.kind !== "presented" ||
            !equalSecret(cookie.token, pairing.cookieToken) || !equalSecret(request.headers["x-webui-native-browser"], pairing.browserKey)) {
          rejectHttp(response, 403, "Native directory selection unavailable"); return;
        }
      }
      if (!credentialPresented(context.credential,
        typeof request.headers["x-webui-token"] === "string" ? request.headers["x-webui-token"] : undefined,
        request.headers.cookie)) {
        rejectHttp(response, 401, "Unauthorized"); return;
      }
      // This command takes no client path, command or options. Empty POST only.
      if ((request.headers["content-length"] !== undefined && request.headers["content-length"] !== "0") ||
          request.headers["transfer-encoding"] !== undefined) {
        rejectHttp(response, 400, "Native directory selection accepts no body"); return;
      }
      if (action === "authorize") {
        pairing ??= { browserKey: randomUUID(), cookieToken: randomUUID() };
        response.setHeader("Set-Cookie", `${cookieName}=${pairing.cookieToken}; Path=/native-directory-picker; SameSite=Strict; HttpOnly`);
        response.setHeader("Content-Type", "application/json");
        response.end(JSON.stringify({ browserKey: pairing.browserKey }));
        return;
      }
      if (active) { rejectHttp(response, 409, "A directory chooser is already open"); return; }
      const controller = new AbortController();
      const abort = () => { if (!response.writableEnded) controller.abort(); };
      request.once("aborted", abort); response.once("close", abort);
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      // Defer choose so the singleton exists even if a provider throws synchronously.
      const settled = Promise.resolve().then(() => picker.choose(controller.signal));
      active = { controller, settled };
      try {
        const result = await settled;
        if (response.destroyed) return;
        if (controller.signal.aborted || result.kind === "cancelled") {
          response.setHeader("Content-Type", "application/json"); response.end(JSON.stringify({ kind: "cancelled" })); return;
        }
        const valid = await validateNativeDirectory(result.directory);
        if (response.destroyed) return;
        if (controller.signal.aborted) {
          response.setHeader("Content-Type", "application/json"); response.end(JSON.stringify({ kind: "cancelled" })); return;
        }
        if (!valid) { rejectHttp(response, 422, "The selected directory is no longer available"); return; }
        response.setHeader("Content-Type", "application/json");
        response.end(JSON.stringify({ kind: "selected", directory: result.directory }));
      } catch {
        if (!response.destroyed) {
          // An abort request is not proof that the native window closed. Only
          // the provider's settled cancellation result establishes that.
          rejectHttp(response, 503, "Native directory selection failed");
        }
      } finally {
        clearTimeout(timer); request.off("aborted", abort); response.off("close", abort); active = undefined;
      }
    },
    async dispose(): Promise<void> {
      closed = true; active?.controller.abort();
      await picker.dispose();
      await active?.settled.catch(() => undefined);
    },
  };
}
