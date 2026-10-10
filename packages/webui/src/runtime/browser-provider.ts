// The browser provider the WebUI process is handed (plan §7.1
// `runtime/browser-provider.ts`, split from `server/assembly.ts`).
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

export type WebuiBrowserToolExposure = "compact" | "full" | "both";

export interface WebuiBrowserAdapter {
  readonly getCapabilities?: () => unknown;
  readonly disposeSession?: (sessionId: string) => Promise<void>;
  execute(
    context: unknown,
    action: string,
    input: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<unknown>;
}

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
