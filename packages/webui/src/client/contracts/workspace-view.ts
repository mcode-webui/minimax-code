// Browser-local workspace view types.
//
// One of the `client/contracts/` split targets named in the runtime layer
// plan §7.1. It holds no declarations today: every workspace and review view
// the client consumes is a shared wire DTO (`shared/contracts/workspace.ts`,
// `review.ts`), and the canvas types `WebuiTransport` must name moved to
// `shared/contracts/canvas.ts` as the wire contract they mirror, so no
// browser-only workspace type remains. The file is kept as the target-layout
// placeholder so a future browser-local workspace view has its declared home.
