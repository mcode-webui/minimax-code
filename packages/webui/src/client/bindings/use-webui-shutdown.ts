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

export function useWebuiShutdown(): () => Promise<void> {
  return useCallback(() => requestWebuiShutdown(), []);
}
