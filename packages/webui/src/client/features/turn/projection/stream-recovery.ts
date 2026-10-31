// The pure history/context transforms the attach path needs, bundled.
//
// `client/conversation/stream-loop.ts` is a mechanism: it reports the raw
// history page and nothing else. Deciding which of those messages a user
// should see when joining a turn in progress is the Turn record's own call, so
// it is made here and consumed by `turn/application/stream-loop-sink.ts`.
//
// The functions are the existing ones, re-used, not re-implemented: no second
// history-to-message conversion is introduced.

import { projectWebuiMessageToStreamMessage } from "../../transcript/contracts/message-stream.js";
import { latestContextUsage, readContextUsageSnapshot } from "../../composer/contracts/context-usage.js";

/** The default bundle: the existing pure projection functions, injected. */
export const streamRecoveryProjection = {
  projectMessage: projectWebuiMessageToStreamMessage,
  latestContextUsage,
  readContextUsageSnapshot,
};
