// The browser provider the WebUI process is handed.
//
// The WebUI does **not** create this provider: the host process supplies it when
// browser tooling is enabled, and this module adopts it — binds it into the
// options the harness factory receives, decides whether tooling counts as
// enabled, and hands the release to the lifecycle owner. Creating the provider,
// owning its configuration and deciding when browser use is allowed all stay
// outside.
//
// Split out of `runtime/assembly.ts` so the assembly wires resources and this
// file states what "adopt an externally supplied provider" means.

import type { CreateLocalRuntimeHostOptions } from "@mavis/local-runtime-v2/process-local";

/**
 * The runtime's own browser-adapter type, read off the options the factory
 * takes. The WebUI never constructs one — the host process supplies it — so
 * this is a forwarding slot, not a shape to declare here.
 */
export type WebuiBrowserAdapter = NonNullable<
  CreateLocalRuntimeHostOptions["browserAdapter"]
>;

/** The runtime's own tool-exposure type, read off the same options. */
export type WebuiBrowserToolExposure = NonNullable<
  CreateLocalRuntimeHostOptions["browserToolExposure"]
>;

export interface WebuiBrowserProvider {
  readonly adapter: WebuiBrowserAdapter;
  close(): void | Promise<void>;
}

/**
 * What the assembly needs from the provider: the adapter and exposure to forward,
 * whether tooling counts as enabled, and the release to register with the
 * lifecycle owner.
 *
 * `browserUseTooling` is a readiness *statement*, not a request: it is true
 * exactly when a provider was adopted, which is what the harness reads.
 */
export interface WebuiBrowserProviderBinding {
  readonly browserAdapter?: WebuiBrowserAdapter;
  readonly browserToolExposure?: WebuiBrowserToolExposure;
  readonly browserUseTooling: boolean;
  readonly closeBrowserProvider: () => void | Promise<void>;
}

export function adoptWebuiBrowserProvider(
  provider: WebuiBrowserProvider | undefined,
  exposure: WebuiBrowserToolExposure | undefined,
): WebuiBrowserProviderBinding {
  return {
    ...(provider ? { browserAdapter: provider.adapter } : {}),
    ...(exposure ? { browserToolExposure: exposure } : {}),
    browserUseTooling: provider !== undefined,
    closeBrowserProvider: () => provider?.close(),
  };
}
