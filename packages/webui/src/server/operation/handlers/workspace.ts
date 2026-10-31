// Dedicated handlers: workspace directory browsing.
//
// `browseWorkspaceDirs` cannot be a plain binding: it does not forward to the
// harness port at all. The browser cannot hand the WebUI an absolute path, so
// the picker asks this process — which already serves this machine's files, git
// and terminals — to name the candidates. That is a server-local resource call,
// not a runtime capability.
import {
  browseWorkspaceDirsOperation,
  listWorkspaceDirectories,
} from "../workspace.js";
import type {
  WebuiOperationHandler,
  WebuiOperationRegistryEntry,
  WebuiOperationValidation,
} from "../operation-contract.js";

type BodyOf<Descriptor> = Descriptor extends {
  readonly validate: (body: unknown) => WebuiOperationValidation<infer Body>;
}
  ? Body
  : never;

type DedicatedHandler<Descriptor> = WebuiOperationHandler<
  BodyOf<Descriptor>,
  unknown
>;

export function createWorkspaceHandlerEntries(): ReadonlyMap<
  string,
  WebuiOperationRegistryEntry
> {
  const browseWorkspaceDirs: DedicatedHandler<
    typeof browseWorkspaceDirsOperation
  > = async (_context, body) => ({
    body: listWorkspaceDirectories(body.dir),
  });
  return new Map([
    [
      browseWorkspaceDirsOperation.name,
      {
        operation: browseWorkspaceDirsOperation,
        handle: browseWorkspaceDirs as WebuiOperationHandler<unknown>,
      },
    ],
  ]);
}
