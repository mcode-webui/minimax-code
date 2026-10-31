// Back-compat re-export for in-flight consumers.
//
// The purpose-named interaction commands
// (`createWebuiInteractionCommands`, `WebuiInteractionCommandTargets`,
// `WebuiInteractionCommands`) live as the publication marker in
// `./session-commands.public.ts`. This private sibling is a shim that
// re-exports the same names so existing importers (the global bindings at
// `client/bindings/use-session-state.ts`, the turn and session test suites)
// can keep their current import path until they migrate to the
// publication marker in turn.
export {
  createWebuiInteractionCommands,
  type WebuiInteractionCommandTargets,
  type WebuiInteractionCommands,
} from "./session-commands.public.js";
