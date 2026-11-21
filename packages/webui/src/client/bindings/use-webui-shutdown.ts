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

import {
  requestWebuiShutdown,
  WebuiShutdownRefused,
} from "../platform/webui-shutdown.js";

/**
 * What the shutdown request found, in the terms the confirmation can show.
 *
 * `stopped` is the state the request was after: the service is not running,
 * whether it said so or simply stopped answering. `failed` carries a
 * message the person can act on -- never the browser's own wording, which
 * describes the network rather than what happened here.
 */
export type WebuiShutdownOutcome =
  | { readonly kind: "stopped" }
  | { readonly kind: "failed"; readonly message: string };

export function useWebuiShutdown(): () => Promise<WebuiShutdownOutcome> {
  return useCallback(async (): Promise<WebuiShutdownOutcome> => {
    try {
      const state = await requestWebuiShutdown();
      if (state === "still-running") {
        return {
          kind: "failed",
          message: "关闭服务失败：本地服务仍在运行，请重试。",
        };
      }
      return { kind: "stopped" };
    } catch (error: unknown) {
      if (error instanceof WebuiShutdownRefused) {
        return { kind: "failed", message: error.message };
      }
      // An error the platform did not name is a defect rather than an
      // answer, and its wording is not something to put in front of a
      // person: they are told the request did not go through.
      return { kind: "failed", message: "关闭服务失败，请重试。" };
    }
  }, []);
}
