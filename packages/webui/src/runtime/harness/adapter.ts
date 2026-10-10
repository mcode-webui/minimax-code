// Wires the harness layer to the WebUI service.
//
// The harness port's `version()` reads the version that the runtime host was
// started with (`appVersion`). The host itself is owned by the runtime
// package, not by the WebUI, so this module is a thin adapter: it accepts
// a host, extracts the version, and exposes the close hook on the harness
// port so the service can shut down the host in the order step 13 of the
// assembly checklist requires.
//
// The host shape is structural so the WebUI does not need to bundle the
// whole harness layer to type-check; the runtime assembly passes the host
// directly at process start.
import { WEBUI_PROTOCOL_VERSION } from "../../shared/envelope.js";
import type { WebuiVersionInfo } from "../../shared/contracts/version.js";
import type { WebuiHarnessPort } from "../port.js";
import type { WebuiRuntimeHostHandle } from "./host-contract.js";
import { createSessionsAdapter } from "./sessions.js";
import { createExecutionAdapter } from "./execution.js";
import { createInteractionsAdapter } from "./interactions.js";
import { createWorkspaceAdapter } from "./workspace.js";
import { createSettingsAdapter } from "./settings.js";
import { createModelsPluginsAdapter } from "./models-plugins.js";
import { createAccountAdapter } from "./account.js";
import { runWebuiCommand } from "../commands/runner.js";

export function createHarnessPortFromHost(
  handle: WebuiRuntimeHostHandle,
): WebuiHarnessPort {
  const host = handle;
  const version: WebuiVersionInfo = {
    version: host.appVersion ?? "unknown",
    protocolVersion: WEBUI_PROTOCOL_VERSION,
    ...(host.dataDir ? { dataDir: host.dataDir } : {}),
  };
  let closed = false;
  const port: Omit<WebuiHarnessPort, "runCommand"> = {
    version() {
      return version;
    },
    async invalidateAuth() {
      host.invalidateAuth?.();
    },
    ...createSessionsAdapter(host),
    ...createExecutionAdapter(host),
    ...createInteractionsAdapter(host),
    ...createWorkspaceAdapter(host),
    ...createSettingsAdapter(host),
    ...createModelsPluginsAdapter(host),
    ...createAccountAdapter(host),
    async close() {
      if (closed) return;
      closed = true;
      await host.apiHost.close();
    },
  };
  return {
    ...port,
    // The slash-command interpreter is runtime logic that reads several port
    // capabilities. Exposing it as a port method is what keeps the server on
    // `runtime-port` instead of importing the runtime implementation beside it.
    runCommand: (request) => runWebuiCommand(port, request),
  };
}
