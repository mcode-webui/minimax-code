// The stream-state transforms the loop needs, bundled so a caller can inject
// them instead of the mechanism importing `projection/` directly (plan §7.2).
// `client/stream-loop.ts` is a mechanism and may import only `contracts` and
// `shared`, so the callers that already sit above that boundary supply this
// bundle, exactly as they supply `streamRecoveryProjection`.
//
// The functions are the existing ones, re-used, not re-implemented. The export
// is left structurally typed (no annotation) so a `view` module does not have to
// import the mechanism-declared `WebuiStreamStateBundle` interface back from the
// loop; TypeScript's structural compatibility is what the caller's expected type
// checks against.

import {
  nextWebuiSubscriptionGeneration,
  recogniseWebuiStreamPayload,
  reduceWebuiStreamFrame,
  releaseWebuiSubscription,
} from "./stream-state.js";

/** The default bundle: the existing pure stream-state functions, injected. */
export const streamStateBundle = {
  nextSubscriptionGeneration: nextWebuiSubscriptionGeneration,
  recognisePayload: recogniseWebuiStreamPayload,
  reduceFrame: reduceWebuiStreamFrame,
  releaseSubscription: releaseWebuiSubscription,
};
