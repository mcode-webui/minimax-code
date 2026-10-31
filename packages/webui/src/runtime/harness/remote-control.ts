// The remote-control cell of the harness port.
//
// The phone link is a host-side capability: the service holds the WebSocket to MiniMax's gateway,
// and the browser drives it. This adapter is the whole of the WebUI's knowledge about that link
// at the port boundary — it forwards and converts, and it decides nothing.
//
// What it deliberately does not do is leak the bridge's own types. `RCStatus`,
// `RCConnectResult` and `RcPendingUnbind` stay inside `runtime/remote-control/`; what crosses
// this line is the wire contract (`shared/contracts/remote-control.ts`), which the browser is
// allowed to know: the phase, the pairing code, its expiry and the pending unbind — never the
// bridge's internal epochs.
//
// The nine members are resolved as one capability. A host without the runtime's CLI service
// cannot host a phone link, so the absence is one stated refusal (`requireHostSlot`) instead of
// nine different failures.
import type { WebuiBrowserPort, WebuiHarnessPort } from "../port.js";
import type { WebuiRuntimeHostHandle } from "./host-contract.js";
import { requireHostSlot } from "./requirements.js";
import { createWebuiRemoteControl } from "../remote-control/owner.js";

/** The nine members the 远程控制 surface binds to. */
type RemoteControlMembers = Pick<
  WebuiHarnessPort,
  | "getRemoteControlStatus"
  | "watchRemoteControlStatus"
  | "connectRemoteControl"
  | "disconnectRemoteControl"
  | "applyRemoteControlCredentials"
  | "reportRemoteControlBindingLost"
  | "getRemoteControlPendingUnbind"
  | "resolveRemoteControlUnbind"
  | "publishRemoteControlComposerMode"
>;

export function createRemoteControlAdapter(host: WebuiRuntimeHostHandle, browserPort?: Pick<WebuiBrowserPort, "getAuthorization" | "setAuthorization">): RemoteControlMembers {
  const controller = createWebuiRemoteControl({ host, ...(browserPort ? { browserPort } : {}) });

  // The phone link is driven by the runtime: without its CLI service there is no event stream to
  // relay, no command router to answer the phone and no permission path to reply through.
  const requireRuntime = (): void => {
    requireHostSlot(host.cliService, "the CLI service");
  };

  return {
    getRemoteControlStatus: async () => {
      requireRuntime();
      return controller.getStatus();
    },
    watchRemoteControlStatus: async () => {
      requireRuntime();
      return controller.watchStatus();
    },
    connectRemoteControl: async (request) => {
      requireRuntime();
      return controller.connect(request);
    },
    disconnectRemoteControl: async (request) => {
      requireRuntime();
      return controller.disconnect(request);
    },
    applyRemoteControlCredentials: async (request) => {
      requireRuntime();
      return controller.applyCredentials(request);
    },
    reportRemoteControlBindingLost: async () => {
      requireRuntime();
      return controller.reportBindingLost();
    },
    getRemoteControlPendingUnbind: async () => {
      requireRuntime();
      return controller.getPendingUnbind();
    },
    resolveRemoteControlUnbind: async (request) => {
      requireRuntime();
      return controller.resolveUnbind(request);
    },
    publishRemoteControlComposerMode: async (request) => {
      requireRuntime();
      return controller.publishComposerMode(request);
    },
  };
}
