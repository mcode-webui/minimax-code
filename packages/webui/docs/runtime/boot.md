# Boot and shutdown

`runtime/assembly.ts` is the composition root: it creates and wires the process resources and injects
them into the harness host and the network service. It embeds no OAuth state machine (that is
`auth-session.ts`) and no close ordering (that is `lifecycle.ts`). The order below is the order in the
code, and each step's failure path is part of the contract.

The assembly carries the broker readiness and the browser provider's lifecycle itself; it cannot be
reduced to passing capability flags into the host.

## Boot: one process-local host per service

1. **Resolve the data directory.** The CLI's default (`~/.minimax`) is shared, per ADR 0006; a run
   needing a clean slate opts into `MINIMAX_DATA_DIR` instead. The WebUI never creates its own.
2. **Reflect the client's region and build scope into the process environment**
   (`runtime-environment.ts`) *before* the host is built, so `getRuntimeRegion()`,
   `getRuntimeBuildEnv()` and `isManagedRuntime()` see the same scope the credential reader served.
   The WebUI does this for itself because ADR 0003 forbids importing the terminal client's module. A
   start with no client-side login falls back to the harness defaults (`en` / `dev`, not managed).
3. **Create the one OAuth core, its lease and its refresh timer** (`auth-session.ts`). It reads the
   shared `mcode login` credential, so a browser session never signs in again. A failure here aborts
   the boot before any host exists.
4. **Adopt the browser provider** (`browser-provider.ts`) and register the disposers with
   `lifecycle.ts`.
5. **Prepare the mcode-tools integration** (`mcode-tools.ts`) when the beta switch or an explicit
   request asks for it. It validates the bundled resource, starts its own auth-lease broker and
   installs the child environment; its readiness is not the same as its configured state — see
   [`../known-gaps.md`](../known-gaps.md).
6. **Build the host** through the forwarded options: `runtimeOwnerKind: "webui"`, `runtimeMode:
   "clean"`, `startupExecutionPolicy: "quarantined"` (unconditional, unlike the CLI which applies it
   per surface — ADR 0002), `capabilities: {cliEmbedded, questionnaireReply, permissionPrompt,
   elicitation}` all true, and `enableLiveMcp: true`. `configGetter` re-reads the config on every
   access so a model switch is visible without a restart.
7. **Wrap the host's close** (`lifecycle.registerHostClose`) and start the auth watch.
8. **Install the mcode-tools command path**; a failure here closes the host before throwing.
9. **Enrich the host handle** with the credential-backed slots the loose handle does not carry:
   `getUsageQuota`, `getSigninPanel`, `claimSignin`, the account-login methods and `signOutAccount`
   (a real revoke-and-remove, not just a projection invalidation). Because consumers rebuild the port
   from `host` (`createHarnessPortFromHost(assembled.host)`), these must live on the handle itself,
   not only on the derived port.
10. **Derive the harness port** and return `{harnessPort, host, forwardedOptions, mcodeTools,
    invalidateAuth}`.

Any failure after a resource was acquired releases what was acquired, and startup errors are folded
into one error or an `AggregateError` labelled "WebUI runtime startup failed".

## Close order

`lifecycle.ts` is the single owner of `close()`, idempotent, and runs:

1. auth teardown (stops the watch, clears the refresh timer),
2. the harness host,
3. the mcode-tools broker,
4. the externally supplied browser provider.

Every failure is collected and rethrown as one error or an `AggregateError`. The pre-host startup
path runs the same owners minus the host. A page unsubscribe never reaches this: closing a browser
connection ends that connection's delivery only. The service's own shutdown is what closes the
runtime.

## Process resources, in one list

OAuth core with lease and refresh timer · account login · daily check-in · usage quota and its pure
projection · request signing · the runtime environment scope · the mcode-tools broker, child
environment and embedded entry · the browser provider · profile files · workspace archive adapters ·
session transfer · the terminal process manager (one per service) · the six slash commands.

## Entries

| Entry | Path | Notes |
| --- | --- | --- |
| Development server | `scripts/run-webui-server.mjs` via `pnpm --filter @mavis/webui dev:server` | Spawns itself under `tsx` with the repository's `tsconfig.standalone.json`; assembles the host, constructs `new WebuiService(...)` with the registry and the terminal manager, calls `service.start()`, and closes the service on SIGINT/SIGTERM. Serves the built client from `dist-webui/client/`. `WEBUI_SERVER_PORT` overrides 8787. |
| Packaged service | `runtime/index.ts` + `server/index.ts` | The runtime's public entry and the server build entry. `scripts/build-webui.mjs` bundles both. |
| npm preview package | `release/webui-npm/` | See [`../releasing.md`](../releasing.md). |

The dev launcher forwards `process.env` verbatim and constructs the host with `dataDir` and
`appVersion`. The mcode-tools broker environment is prepared by the runtime assembly and passed to
the embedded child entry; it is not supplied by the launcher.
