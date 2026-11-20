import type { WebuiHarnessPort } from "../port.js";
import type { WebuiRuntimeHostHandle } from "./host-contract.js";
import { WebuiCapabilityUnavailableError } from "../../shared/envelope.js";

export function createDesignAdapter(host: WebuiRuntimeHostHandle): Pick<WebuiHarnessPort, "getDesignState" | "applyDesignAction" | "readDesignAsset"> {
  const authority = () => { if (!host.design) throw new WebuiCapabilityUnavailableError("Native Design is unavailable on this host"); return host.design; };
  return { getDesignState: (request) => authority().getState(request), applyDesignAction: (request) => authority().apply(request), readDesignAsset: (request) => authority().readAsset(request) };
}
