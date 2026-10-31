# WebUI artifacts build separately from the CLI bundle

`packages/webui` gets its own build, type check, boundary check and Vitest suite,
producing `dist-webui/` with its own metafile. It is not added to the CLI build's
entry points, and the CLI release package does not carry it. The CLI boundary check
reads `dist/metafile.json` and asserts that CLI capabilities are present in that
graph; merging two products into one metafile would make the check meaningless for
both.

## Consequences

New verification gates belong in the shared verifier, not in the workflow file. The
WebUI needs its own TypeScript configuration for browser and server code: the
standalone config is generated from the package scope and type-checks the CLI entry
points, so "the paths were regenerated" is not "the WebUI type-checks". Registering
the package in the workspace and the package scope is wiring, not verification — a
boundary check has to inspect the WebUI's own build graph for retired source paths,
terminal-renderer dependencies, forbidden internal addresses, and any server-side
call back into the CLI.
