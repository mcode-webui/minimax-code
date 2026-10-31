// Server-side projections the operation handlers still perform.
//
// `getMessages` enriches its response with the session context snapshot and the
// turn usage, so those two stay. The session-stream projection that used to
// wrap `sendMessage` / `resumeSession` frames is gone: it attached a
// per-session permission/compaction snapshot to every frame, and nothing on the
// client ever read it — the browser builds the permission and questionnaire
// state the panels render in `client/features/turn/application/effect-reducer.ts`.
export { projectContextSnapshot } from "./context-snapshot.js";
export { isTurnCompactionMessage, projectUsage } from "./usage.js";
