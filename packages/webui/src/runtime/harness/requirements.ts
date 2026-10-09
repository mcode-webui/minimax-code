// Required runtime host slots and capability guards.
//
// Every harness port method that has no equivalent on the auth/quota/check-in
// side flows through these helpers so a missing slot becomes one explicit,
// uniform error (`runtime host does not expose ...`) instead of an `undefined`
// call. The port's optional hooks are resolved here, never during assembly.
import type { WebuiRuntimeHostHandle, WebuiRuntimeCliService } from "./host-contract.js";
import type { WebuiMemorySettingsView } from "../../shared/contracts/personalization.js";

/**
 * Resolve the runtime host's `cliService` slot. Every harness port method
 * that has no equivalent on the auth/quota/check-in side flows through this
 * helper so the failure message is the same as it was before the batch-C
 * seam work.
 */
export function requireCliService(host: WebuiRuntimeHostHandle): WebuiRuntimeCliService {
  if (!host.cliService)
    throw new Error("runtime host does not expose the CLI service");
  return host.cliService;
}

export function requireDataDir(host: WebuiRuntimeHostHandle): string {
  if (!host.dataDir)
    throw new Error("runtime host does not expose a data directory");
  return host.dataDir;
}

/**
 * The memory switches reach the shared config through the runtime's own
 * `configuration` capability, so the whitelist and the mask hazard stay where
 * they already live — the WebUI only forwards two booleans.
 */
export function requireMemorySettings(host: WebuiRuntimeHostHandle): {
  get(): Promise<WebuiMemorySettingsView>;
  set(request: {
    readonly enabled?: boolean;
    readonly proactive?: boolean;
  }): Promise<WebuiMemorySettingsView>;
} {
  const cliService = requireCliService(host);
  const { getMemorySettings, setMemorySettings } = cliService;
  if (!getMemorySettings || !setMemorySettings)
    throw new Error("runtime host does not expose memory settings");
  return {
    get: () => getMemorySettings.call(cliService),
    set: (request) => setMemorySettings.call(cliService, request),
  };
}
