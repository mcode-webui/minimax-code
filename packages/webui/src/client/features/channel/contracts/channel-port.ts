// The 接入 IM business's transport seam.
//
// The six members are optional on purpose: a build whose transport does not carry them yet leaves
// a member `undefined`, and the owner turns that into one stated refusal instead of a crash or an
// empty list that reads as "no IM client is bound".
//
// The request and response types are the shared wire DTOs. This file may not name the runtime's
// channel views — `shared/contracts/channel.ts` is what the browser is allowed to know, and the
// adapter behind the harness is where the conversion happens.
import type {
  WebuiChannelConfigCheckRequest,
  WebuiChannelConfigCheckResult,
  WebuiChannelConnectRequest,
  WebuiChannelDisconnectRequest,
  WebuiChannelMessageFilter,
  WebuiChannelMessageFilterRequest,
  WebuiChannelOperationResult,
  WebuiChannelStatus,
} from "../../../../shared/contracts/channel.js";

export interface ChannelPort {
  readonly listChannelStatus?: () => Promise<WebuiChannelStatus>;
  readonly connectChannel?: (
    request: WebuiChannelConnectRequest,
  ) => Promise<WebuiChannelOperationResult>;
  readonly disconnectChannel?: (
    request: WebuiChannelDisconnectRequest,
  ) => Promise<WebuiChannelOperationResult>;
  readonly checkChannelConfig?: (
    request: WebuiChannelConfigCheckRequest,
  ) => Promise<WebuiChannelConfigCheckResult>;
  readonly getChannelMessageFilter?: (request: {
    readonly agent: string;
  }) => Promise<WebuiChannelMessageFilter>;
  readonly updateChannelMessageFilter?: (
    request: WebuiChannelMessageFilterRequest,
  ) => Promise<WebuiChannelMessageFilter>;
}
