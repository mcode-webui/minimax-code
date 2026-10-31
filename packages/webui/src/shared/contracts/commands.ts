// Wire contract record: every exported
// declaration below records its wire purpose, its producer and its
// consumers, verified against the tree. Documentation only.
//
// | Declaration | Wire purpose | Producer | Consumers |
// | --- | --- | --- | --- |
// | `WEBUI_RUN_COMMAND_NAMES` | The command vocabulary `runCommand` accepts, in `/help` order. | Shared literal. | `runtime/commands/descriptors.ts` (the descriptor set must match it), `server/operation/provider.ts` (body validation), `client/features/composer/contracts/slash-command.ts` (re-exported for the palette), `client/features/composer/ui/WebuiComposer.tsx` (the prop's union). |
// | `WebuiRunCommandName` | One accepted command name. | Derived from the list. | `client/features/composer/contracts/slash-command.ts`, `client/features/composer/projection/composer-state.ts`, `client/features/composer/ui/WebuiComposer.tsx`. |
//
// This list lives in `shared` because all three sides need it and `shared` is
// the only layer they may all reach: `server` may import `shared` and
// `runtime-port`, `contracts` may import `shared`, and `runtime` may import
// `shared`. Before this, the same six names were written out four times — here
// in the client, inline in the server's validator, as the descriptors' keys in
// the runtime, and as a literal union on a component prop — so adding a command
// meant finding all four.

/** The command vocabulary `runCommand` accepts, in the order `/help` lists it. */
export const WEBUI_RUN_COMMAND_NAMES = [
  "help",
  "new",
  "compact",
  "status",
  "usage",
  "model",
] as const;

export type WebuiRunCommandName = (typeof WEBUI_RUN_COMMAND_NAMES)[number];
