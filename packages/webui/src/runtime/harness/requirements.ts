// Required runtime host slots and capability guards.
//
// Every harness port method that has no equivalent on the auth/quota/check-in
// side flows through these helpers so a missing slot becomes one explicit,
// uniform error (`runtime host does not expose ...`) instead of an `undefined`
// call. The port's optional hooks are resolved here, never during assembly.
import type { WebuiRuntimeHostHandle, WebuiRuntimeCliService } from "./host-contract.js";
import type { WebuiMemorySettingsView } from "../../shared/contracts/personalization.js";
import { WebuiCapabilityUnavailableError } from "../../shared/envelope.js";

/**
 * Resolve one optional host slot, or fail with the uniform message.
 *
 * The slot's name is the caller's, because the message has to say which
 * capability is missing: `/compact` tells the user the host does not support
 * compaction, not that its CLI service is absent. Every guard in this group
 * used to spell the `if (!…) throw` out by hand, which is how three of them
 * ended up as non-null assertions instead.
 */
export function requireHostSlot<T>(value: T | undefined, what: string): T {
  if (!value) throw new WebuiCapabilityUnavailableError(`runtime host does not expose ${what}`);
  return value;
}

export function requireCliService(host: WebuiRuntimeHostHandle): WebuiRuntimeCliService {
  return requireHostSlot(host.cliService, "the CLI service");
}

export function requireDataDir(host: WebuiRuntimeHostHandle): string {
  return requireHostSlot(host.dataDir, "a data directory");
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
