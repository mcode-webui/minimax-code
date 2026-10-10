// Public surface of the WebUI runtime integration layer (Node side).
//
// Exports the runtime factory, the capability interface the runtime produces,
// and the lifecycle handle the close owner exposes — nothing else. The resource
// internals (`auth-session`, `lifecycle` implementation, the profile/transfer
// modules) are composed through `createWebuiRuntimeHost` and torn down through
// the host handle it returns; re-exporting them here would invite a second
// composition root.
//
// The Node startup file imports this module and `server/index.ts` separately
// (plan section 7.5): the runtime does not depend on the network service, and
// the network service consumes runtime capabilities rather than re-declaring
// them.

export {
  createWebuiRuntimeHost,
  type CreateWebuiRuntimeHostOptions,
  type WebuiAssembledHost,
  type WebuiBrowserAdapter,
  type WebuiBrowserProvider,
  type WebuiBrowserToolExposure,
  type WebuiForwardedRuntimeHostOptions,
  type WebuiRuntimeHost,
  type WebuiRuntimeHostFactory,
} from "./assembly.js";
export { createHarnessPortFromHost } from "./harness/adapter.js";
export type { WebuiHarnessPort } from "./port.js";
export type { WebuiRuntimeHostHandle } from "./harness/host-contract.js";
export type { WebuiRuntimeCliService } from "./harness/host-contract.js";
export type { WebuiRuntimeLifecycle } from "./lifecycle.js";
