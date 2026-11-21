// The React edge to the shutdown request.
//
// The request itself -- posting it to the service that served this page -- is
// browser IO and lives in `client/platform/webui-shutdown.ts`. A feature's
// presentation does not call an IO port, so this binding is the door between
// the two: the menu asks it to stop, and it asks the platform.
//
// Nothing here decides whether the person meant it. The confirmation that
// precedes the request lives with the menu that offers it.

import { useCallback } from "react";

import { requestWebuiShutdown } from "../platform/webui-shutdown.js";

type WebuiShutdownOutcome =
  | { readonly kind: "accepted" }
  | { readonly kind: "unconfirmed" | "refused"; readonly message: string };

const unconfirmed: WebuiShutdownOutcome = {
  kind: "unconfirmed",
  message: "未收到关闭确认，无法确定服务是否已停止。你可以关闭此提示，或手动重试。",
};

export function useWebuiShutdown(): () => Promise<WebuiShutdownOutcome> {
  return useCallback(async (): Promise<WebuiShutdownOutcome> => {
    try {
      const receipt = await requestWebuiShutdown();
      switch (receipt.kind) {
        case "accepted":
          return { kind: "accepted" };
        case "not-connected":
          return { kind: "refused", message: "当前 WebUI 未连接运行时，无法关闭服务。" };
        case "refused":
          return {
            kind: "refused",
            message: receipt.status === 404
              ? "当前 WebUI 不支持关闭服务。"
              : `关闭服务失败（HTTP ${receipt.status}）。`,
          };
        case "unknown":
          return unconfirmed;
      }
    } catch {
      return unconfirmed;
    }
  }, []);
}
