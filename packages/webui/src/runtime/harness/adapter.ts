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
import { createMiniAppAdapter } from "./miniapp.js";
import { createMiniAppAgentAdapter } from "./miniapp-agent.js";
import { createAccountAdapter } from "./account.js";
import { createCronAdapter } from "./cron.js";
import { runWebuiCommand } from "../commands/runner.js";
import { importWebuiSessionTransfer } from "../session-transfer.js";

/**
 * What the harness port needs beyond the host.
 *
 * The session-ended hook is the edge a session's end needs: the runtime has
 * no per-session lifecycle signal, and the composition root is the only place
 * that holds both the harness port and the browser service, so it is the
 * place that can wire the two together.
 */
export interface CreateHarnessPortOptions {
  /**
   * Called when a session has ended — deleted, archived, or transferred away.
   *
   * The composition root hands this to the browser service, so a session that
   * ends leaves no page behind in the isolated Chromium.
   */
  readonly onSessionEnded?: (sessionId: string) => void | Promise<void>;
}

export function createHarnessPortFromHost(
  handle: WebuiRuntimeHostHandle,
  options: CreateHarnessPortOptions = {},
): WebuiHarnessPort {
  const host = handle;
  // Filled in below, once the port exists: the manifest is a fact about what was
  // actually wired, so it cannot be written before the thing it describes. The
  // getter reads the binding, so the caller always sees the completed fact.
  let version: WebuiVersionInfo = {
    version: host.appVersion ?? "unknown",
    protocolVersion: WEBUI_PROTOCOL_VERSION,
    ...(host.dataDir ? { dataDir: host.dataDir } : {}),
  };
  let closed = false;
  const port: Omit<WebuiHarnessPort, "runCommand" | "importSessionTransferWorkflow"> = {
    version() {
      return version;
    },
    async invalidateAuth() {
      host.invalidateAuth?.();
    },
    ...createSessionsAdapter(host, options),
    ...createExecutionAdapter(host),
    ...createInteractionsAdapter(host),
    ...createWorkspaceAdapter(host),
    ...createSettingsAdapter(host),
    ...createModelsPluginsAdapter(host),
    ...createMiniAppAdapter(host),
    ...createMiniAppAgentAdapter(host),
    ...createAccountAdapter(host),
    ...createCronAdapter(host),
    async close() {
      if (closed) return;
      closed = true;
      await host.apiHost.close();
    },
  };
  const harnessPort: WebuiHarnessPort = {
    ...port,
    // The slash-command interpreter is runtime logic that reads several port
    // capabilities. Exposing it as a port method is what keeps the server on
    // `runtime-port` instead of importing the runtime implementation beside it.
    runCommand: (request) => runWebuiCommand(port, request),
    importSessionTransferWorkflow: (input) => importWebuiSessionTransfer(port, input),
    /**
     * Which optional host services are behind this harness, as of this call.
     *
     * The same lookups the call sites make (`requireHostSlot(host.beginAccountLogin, ...)`):
     * answered here so the handshake can report what a call would find, and answered per call
     * so a host that gains or loses a service does not need a rebuilt manifest.
     */
    readHostPrerequisites: () => ({
      accountLogin: host.beginAccountLogin !== undefined,
      accountSignin: host.getSigninPanel !== undefined,
      accountUsage: host.getUsageQuota !== undefined,
      accountSignOut: host.signOutAccount !== undefined,
      canvasDocuments: host.cliService?.readCanvas !== undefined,
      canvasWrites: host.cliService?.applyCanvas !== undefined,
    }),
  };

  // Availability is not decided here. This object says what the harness *can* forward and
  // which host services stand behind it; whether an operation was registered and bound is a
  // fact about the service, and the service derives the handshake's answer from its registry
  // and these facts (`server/service.ts`). A wrapper around a host service that is not there
  // forwards happily, and advertising a family from its mere presence is how a surface gets
  // offered for a call that cannot work.
  return harnessPort;
}
