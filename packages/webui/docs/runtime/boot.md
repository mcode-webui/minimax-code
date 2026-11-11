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
   A complete explicit environment pair wins, otherwise it resolves the live OAuth namespace. A
   fresh install with no account scope defaults to `cn/prod`, so the login page reaches the
   production account service instead of the old `en/dev` placeholder endpoint.
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

`lifecycle.ts` is the single owner of `close()`, idempotent. Process resources registered through
`registerShutdownResource` (including the lazy remote-control owner) are released before the following
host/auth sequence. Every registered release is attempted
even when a peer release fails. Harness adapters used without the assembly retain the same release
authority in their port's `close()`.

1. auth teardown (stops the watch, clears the refresh timer),
2. the harness host,
3. the mcode-tools broker,
4. the externally supplied browser provider.

The SSH repositories serialize read/transform/commit under a cross-process SQLite OS write lock,
then atomically rename the committed JSON before releasing that lock. The sibling
`*.transaction.sqlite` lock file has no application tables and must retain its inode; it is never
deleted or reclaimed by age. Process exit releases the kernel lock, while a paused live writer
retains it through awaited write/rename. Missing JSON files mean an empty
store; malformed JSON, unsupported versions, invalid records and read failures refuse both reads
and mutations while preserving the original file. Legacy version-1 documents without a numeric
revision read as revision 0, matching the earlier reader, and normalize on a successful write.
Unknown document, record and endpoint fields survive mutations in both stores; public projections
still expose only known fields. Probe commits compare the endpoint and the
captured store revision under that same transaction. A changed host list invalidates the verdict,
including deletion followed by recreation with the same endpoint; the existing JSON format is
unchanged. A concurrent change to another host can conservatively invalidate a probe too.

SSH password delivery is an explicit authentication capability shared by probes, directory listing
and terminals. If askpass cannot start, key authentication remains available; password saves fail
with `credential_unavailable` and the original failure message before staging or spawning.
Probe and directory-list attempts retain a redaction scope over all credentials staged for their
alias during execution. Credential replacement or removal cannot expose an older attempt's secret;
redaction runs before error truncation and the scope is released when the attempt settles.

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
| Development server | `scripts/run-webui-server.mjs` via `pnpm --filter @mavis/webui dev:server` | Spawns itself under `tsx` with the repository's `tsconfig.standalone.json`; assembles the host, constructs `new WebuiService(...)` with the registry and the terminal manager, calls `service.start()`, and closes the service on SIGINT/SIGTERM or an authenticated `POST /webui-shutdown`. The HTTP route acknowledges the request before the same bounded process cleanup starts. Serves the built client from `dist-webui/client/`. `WEBUI_SERVER_PORT` overrides 2233. `WEBUI_HOST` overrides the bind address (`127.0.0.1` by default); a wider bind prints the LAN URLs and the per-start credential, and a request that did not arrive over loopback presents that credential (ADR 0031). |
| Packaged service | `runtime/index.ts` + `server/index.ts` | The runtime's public entry and the server build entry. `scripts/build-webui.mjs` bundles both. |
| npm preview package | `release/webui-npm/` | See [`../releasing.md`](../releasing.md). |

The packaged `mcode-webui --full-access` flag explicitly disables WebUI token authentication.
The launcher passes the same `fullAccess` option to `WebuiService` and the Mini App proxy registry,
so HTTP routes, WebSocket channels and the shared Mini App listener agree. It prints token-free URLs
and the client document receives no credential cookie or token. Host/Origin admission and the
independent Chrome/Edge extension pairing remain in force. The flag does not change runtime account
credentials, tool permissions, or the bind address. Default startup retains the credential policy.

The dev launcher forwards `process.env` verbatim and constructs the host with `dataDir` and
`appVersion`. The mcode-tools broker environment is prepared by the runtime assembly and passed to
the embedded child entry; it is not supplied by the launcher.
