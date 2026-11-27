// Desktop capability supplied only by an interactive local launcher. General
// WebUI credentials alone never authorize opening native desktop UI.
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { once } from "node:events";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { credentialFromCookie, credentialMatches, credentialPresented, type WebuiCredential } from "../credentials.js";
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
const forwarded = (request: IncomingMessage) => Object.keys(request.headers).some((key) => key === "forwarded" || key.startsWith("x-forwarded-"));

// A browser that reached WebUI through a single forwarded port cannot reach
// this second listener on its own loopback interface. No bearer or cookie is
// sent there. The proof only pairs a browser at the original WebUI origin.
function startLocalPairing(host: string, origin: string) {
  const proof = randomUUID();
  const controller = new AbortController();
  const server = createServer((req, res) => {
    res.setHeader("Cache-Control", "no-store");
    const address = server.address();
    if (!address || typeof address === "string" || !loopback(req.socket.remoteAddress) || forwarded(req) ||
        req.method !== "POST" || req.url !== "/" || req.headers.origin !== origin ||
        req.headers.host !== `${new URL(origin).hostname}:${address.port}` ||
        req.headers["sec-fetch-site"] !== "same-site" || req.headers["sec-fetch-mode"] !== "cors" ||
        (req.headers["content-length"] !== undefined && req.headers["content-length"] !== "0") || req.headers["transfer-encoding"] !== undefined) {
      rejectHttp(res, 403, "Native browser pairing unavailable"); return;
    }
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ proof }));
  });
  server.maxConnections = 8;
  server.unref();
  const ready = once(server, "listening", { signal: controller.signal }).then(() => {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Local pairing listener unavailable");
    return `http://${new URL(origin).hostname}:${address.port}`;
  });
  server.listen({ host, port: 0, signal: controller.signal });
  const timer = setTimeout(close, 10_000).unref();
  function close() {
    clearTimeout(timer);
    controller.abort();
    server.closeAllConnections();
  }
  return { proof, ready, close, signal: controller.signal };
}
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
  let localPairing: ReturnType<typeof startLocalPairing> | undefined;
  let closed = false;
  return {
    async handle(request: IncomingMessage, response: ServerResponse, context: Admission, action: "choose" | "authorize" = "choose"): Promise<void> {
      response.setHeader("Cache-Control", "no-store");
      const authority = context.host === "::1" ? `[::1]:${context.port}` : `${context.host}:${context.port}`;
      if (closed || context.fullAccess || !loopback(context.host) || !loopback(request.socket.remoteAddress) ||
          !context.port || request.headers.host !== authority || request.headers.origin !== `http://${authority}` ||
          request.headers["sec-fetch-site"] !== "same-origin" ||
          forwarded(request)) {
        rejectHttp(response, 403, "Native directory selection unavailable"); return;
      }
      const cookieName = `webui_native_directory_${context.port}`;
      const local = action === "authorize" && request.headers["x-webui-native-local"] === "1";
      if (local) {
        const cookie = credentialFromCookie(request.headers.cookie);
        if (cookie.kind !== "presented" || !credentialMatches(context.credential, cookie.token) ||
            !equalSecret(request.headers["x-webui-token"], context.credential.token)) {
          rejectHttp(response, 401, "Unauthorized"); return;
        }
      } else if (!equalSecret(request.headers["x-webui-native-grant"], picker.grant)) {
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
        if (local) {
          const proof = request.headers["x-webui-native-proof"];
          if (proof === undefined) {
            try {
              if (!localPairing || localPairing.signal.aborted) localPairing = startLocalPairing(context.host, `http://${authority}`);
              const localOrigin = await localPairing.ready;
              response.setHeader("Content-Type", "application/json");
              response.end(JSON.stringify({ localOrigin }));
            } catch {
              localPairing?.close();
              rejectHttp(response, 503, "Native browser pairing unavailable");
            }
            return;
          }
          if (!localPairing || localPairing.signal.aborted || !equalSecret(proof, localPairing.proof)) {
            rejectHttp(response, 403, "Native browser pairing unavailable"); return;
          }
          localPairing.close();
        }
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
      localPairing?.close();
      closed = true; active?.controller.abort();
      await picker.dispose();
      await active?.settled.catch(() => undefined);
    },
  };
}
