// How a render failure is normalised for the boundary to report.
//
// Carved out of `client/shell/WebuiErrorBoundary.tsx` by Phase 4b: the derivation moves to the
// layer that already owns the concept instead of riding along in the
// component that renders it. What moves is
// **1 declaration**, 1 function.
//
// The text below is the declaration as it stood in the source module — no
// behaviour change.

/**
 * Normalises whatever a render threw. A component may throw a string or a
 * plain object, and the fallback must not itself throw while reporting the
 * failure — so the conversion happens once, here, instead of at each use site.
 * `String` is total for every value, which is what keeps the reporting path
 * free of a second failure.
 */
export function describeWebuiBoundaryError(error: unknown): Error {
  if (error instanceof Error) return error;
  return new Error(String(error));
}
