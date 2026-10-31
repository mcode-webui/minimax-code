// The stream-state transforms the delivery sink applies, bundled.
//
// The generation counter and the currency predicate live in
// `client/conversation/stream-lease.ts`, so this bundle is an `application`
// module. The mechanism in `client/conversation/stream-loop.ts` may import only
// `contracts` and `shared`, so it never sees these functions: it hands the sink
// a frame and the sink decides what the record says about it.
//
// The aggregate transforms — claim and the scoped release — are this business's
// and live in `./stream-lease.ts`. The functions are the existing ones, re-used,
// not re-implemented.

import { recogniseWebuiStreamPayload, reduceWebuiStreamFrame } from "../projection/stream-state.js";
import { nextWebuiLeaseGeneration } from "../../../conversation/stream-lease.js";
import { releaseWebuiSubscription } from "./stream-lease.js";

/** The default bundle: the existing pure stream-state functions, injected. */
export const streamStateBundle = {
  nextSubscriptionGeneration: nextWebuiLeaseGeneration,
  recognisePayload: recogniseWebuiStreamPayload,
  reduceFrame: reduceWebuiStreamFrame,
  releaseSubscription: releaseWebuiSubscription,
};
