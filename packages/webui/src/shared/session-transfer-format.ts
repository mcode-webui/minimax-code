// The session transfer format tag, shared by both sides of the HTTP boundary.
//
// The file is written by `SessionTransferApplication` in
// `@mavis/local-runtime-v2` and read back by `session-import.ts` in the
// client. Those two live in different packages and the client must not import
// the runtime, so the tag is declared here and both sides are pinned to it by
// a test that compares this constant against the runtime's own.
//
// Without that test the two could drift silently: the client would go on
// accepting (or rejecting) a tag the server no longer writes, and the symptom
// would be an import that fails only for real users, only on files produced
// after the change.

export const WEBUI_SESSION_TRANSFER_FORMAT = "mcode-webui-session-transfer@1";
