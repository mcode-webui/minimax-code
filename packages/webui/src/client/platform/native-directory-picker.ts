// Ephemeral desktop grant: only the local launcher gives it to its auto-opened
// page. Never persist it, expose it in runtime config, or send it cross-origin.
import { readWebuiSessionTransferTarget } from "./session-transfer-target.js";
import { getWebuiBrowserStorage } from "./storage.js";

export type NativeWorkspaceDirectoryResult =
  | { readonly kind: "selected"; readonly directory: string }
  | { readonly kind: "cancelled" }
  | { readonly kind: "unavailable" };
const pairingKey = "webui.native-directory.browser.v1";
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/iu;
let launchPairing: Promise<string | undefined> | undefined;

function localTarget() {
  const url = new URL(globalThis.location.href);
  const target = readWebuiSessionTransferTarget();
  if (url.protocol === "http:" && (url.hostname === "127.0.0.1" || url.hostname === "[::1]") &&
      target?.origin === url.origin && target.token) return target;
}

async function pairBrowser(origin: string, token: string, grant: string): Promise<string | undefined> {
  const response = await globalThis.fetch(`${origin}/native-directory-picker/authorize`, {
    method: "POST", mode: "same-origin", credentials: "same-origin", redirect: "error",
    headers: { "X-Webui-Native-Grant": grant, "X-Webui-Token": token },
  });
  if (!response.ok) return;
  const result: unknown = await response.json();
  if (!result || typeof result !== "object" || !("browserKey" in result) ||
      typeof result.browserKey !== "string" || !uuid.test(result.browserKey)) return;
  // This value only works with the independent HttpOnly cookie from this launch.
  try { getWebuiBrowserStorage()?.setItem(pairingKey, result.browserKey); }
  catch { /* The launcher tab can still use its in-memory key. */ }
  return result.browserKey;
}

export function captureNativeDirectoryLaunchGrant(): void {
  launchPairing = undefined;
  const url = new URL(globalThis.location.href);
  const fragment = new URLSearchParams(url.hash.slice(1));
  const grant = fragment.get("nativeDirectoryGrant");
  if (grant === null) return;
  fragment.delete("nativeDirectoryGrant");
  url.hash = fragment.toString();
  // Remove even an invalid grant before any app routing or other interactions.
  globalThis.history.replaceState(globalThis.history.state, "", url.href);
  const target = localTarget();
  if (target && uuid.test(grant)) {
    launchPairing = pairBrowser(target.origin, target.token, grant).catch(() => undefined);
  }
}
export async function pickNativeWorkspaceDirectory(signal: AbortSignal): Promise<NativeWorkspaceDirectoryResult> {
  const target = localTarget();
  if (!target) return { kind: "unavailable" };
  let browserKey = await launchPairing;
  // A later launch may have paired another tab since this page loaded.
  try { browserKey = getWebuiBrowserStorage()?.getItem(pairingKey) ?? browserKey; }
  catch { /* Use this tab's key when browser storage cannot be read. */ }
  if (!browserKey || !uuid.test(browserKey)) return { kind: "unavailable" };
  const response = await globalThis.fetch(`${target.origin}/native-directory-picker`, {
    method: "POST", mode: "same-origin", credentials: "same-origin", redirect: "error", signal,
    headers: { "X-Webui-Native-Browser": browserKey, "X-Webui-Token": target.token },
  });
  if ([401, 403, 404].includes(response.status)) return { kind: "unavailable" };
  if (!response.ok) throw new Error(response.status === 409 ? "已有系统目录选择窗口，请先完成或取消。" : "系统目录选择失败，请重试。");
  const result: unknown = await response.json();
  if (result && typeof result === "object" && "kind" in result) {
    if (result.kind === "cancelled") return { kind: "cancelled" };
    if (result.kind === "selected" && "directory" in result && typeof result.directory === "string" && result.directory.length > 0)
      return { kind: "selected", directory: result.directory };
  }
  throw new Error("系统目录选择返回了无效结果。");
}
