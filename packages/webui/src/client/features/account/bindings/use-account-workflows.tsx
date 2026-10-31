// Back-compat re-export for in-flight consumers.
//
// The account-workflows React bindings (Provider, `useWebuiAccountWorkflows`,
// `useWebuiAccountWorkflowsState`) live as the publication marker in
// `./use-account-workflows.public.tsx`. This private sibling is a shim that
// re-exports the same names so existing importers (the shell's foundation
// app, the composer's draft loop) can keep their current import path until
// they migrate to the publication marker in turn.
export {
  WebuiAccountWorkflowsProvider,
  useWebuiAccountWorkflows,
  useWebuiAccountWorkflowsState,
} from "./use-account-workflows.public.js";
