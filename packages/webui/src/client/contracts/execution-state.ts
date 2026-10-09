// Browser-local execution state types.
//
// One of the `client/contracts/` split targets named in the runtime layer
// plan §7.1. It holds no declarations today: the active-turn wire trio
// (`WebuiActiveTurn`, `WebuiActiveTurnRequest`, `WebuiActiveTurnResult`) is a
// shared wire DTO declared in `shared/contracts/session.ts`, and the former
// duplicate copies in `client/contracts.ts` were deleted in this slice.
// The browser's own per-session turn record (plan §7.6) is application state,
// not a contract, so no browser-local execution type remains here yet.
