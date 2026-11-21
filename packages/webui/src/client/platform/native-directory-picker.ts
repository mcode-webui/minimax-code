// Ephemeral desktop grant: only the local launcher gives it to its auto-opened
// page. Never persist it, expose it in runtime config, or send it cross-origin.
import { readWebuiSessionTransferTarget } from "./session-transfer-target.js";

export type NativeWorkspaceDirectoryResult =
  | { readonly kind: "selected"; readonly directory: string }
  | { readonly kind: "cancelled" }
  | { readonly kind: "unavailable" };
let launch: { readonly origin: string; readonly grant: string } | undefined;

export function captureNativeDirectoryLaunchGrant(): void {
  launch = undefined;
  const url = new URL(globalThis.location.href);
  const fragment = new URLSearchParams(url.hash.slice(1));
  const grant = fragment.get("nativeDirectoryGrant");
  if (grant === null) return;
  fragment.delete("nativeDirectoryGrant");
  url.hash = fragment.toString();
  // Remove even an invalid grant before any app routing or other interactions.
  globalThis.history.replaceState(globalThis.history.state, "", url.href);
  if (url.protocol === "http:" && (url.hostname === "127.0.0.1" || url.hostname === "[::1]") &&
      /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/iu.test(grant)) {
    launch = { origin: url.origin, grant };
  }
}
export function canPickNativeWorkspaceDirectory(): boolean {
  const target = readWebuiSessionTransferTarget();
  return Boolean(launch && target?.origin === launch.origin && target.token);
}
export async function pickNativeWorkspaceDirectory(signal: AbortSignal): Promise<NativeWorkspaceDirectoryResult> {
  const target = readWebuiSessionTransferTarget();
  if (!launch || !target?.token || target.origin !== launch.origin) return { kind: "unavailable" };
  const response = await globalThis.fetch(`${launch.origin}/native-directory-picker`, {
    method: "POST", credentials: "same-origin", signal,
    headers: { "X-Webui-Native-Grant": launch.grant, "X-Webui-Token": target.token },
  });
  if ([401, 403, 404].includes(response.status)) { launch = undefined; return { kind: "unavailable" }; }
  if (!response.ok) throw new Error(response.status === 409 ? "已有系统目录选择窗口，请先完成或取消。" : "系统目录选择失败，请重试或选择服务端目录。");
  const result: unknown = await response.json();
  if (result && typeof result === "object" && "kind" in result) {
    if (result.kind === "cancelled") return { kind: "cancelled" };
    if (result.kind === "selected" && "directory" in result && typeof result.directory === "string" && result.directory.length > 0)
      return { kind: "selected", directory: result.directory };
  }
  throw new Error("系统目录选择返回了无效结果。");
}
