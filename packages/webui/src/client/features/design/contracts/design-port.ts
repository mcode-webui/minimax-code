import type {
  ApplyDesignActionRequest,
  DesignState,
  GetDesignStateRequest,
} from "../../../../shared/contracts/design.js";
import type { WebuiVersionInfo } from "../../../../shared/contracts/version.js";

/** Native Design capabilities; no Mini App process or bridge is involved. */
export interface DesignPort {
  readonly version?: () => Promise<WebuiVersionInfo>;
  readonly getDesignState?: (
    request: GetDesignStateRequest,
  ) => Promise<DesignState>;
  readonly applyDesignAction?: (
    request: ApplyDesignActionRequest,
  ) => Promise<DesignState>;
  readonly designStandaloneUrl?: (request: GetDesignStateRequest) => string;
  readonly designAssetUrl?: (url: string) => string;
  readonly designSessionUrl?: (sessionId: string) => string;
}
