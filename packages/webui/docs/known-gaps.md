# Known gaps

Capabilities the WebUI does not have, verified against the tree. Each entry says what was checked,
how, and what remains unverified. "Not implemented" and "not decided" are different states and are
kept apart here; the undecided ones are also in `open-questions.md`.

Last verified: 2026-10-21, against `webui` at `ccc51961`. This list covers capabilities; open
decisions are in [`open-questions.md`](open-questions.md).

## 1. Connector and App tools depend on a beta feature, and on the model finding them

**Implemented, not reachable by default.** The chain is complete and self-contained: the assembly
prepares the integration (`runtime/mcode-tools.ts`), which validates the bundled resource, creates a
runtime directory and **starts its own auth-lease broker**, then
`activateWebuiMcodeToolsEnvironment` installs the host-only keys. The child launcher
(`server/internal-bin/mcode-tools`, copied by `scripts/build-webui.mjs`) execs
`server/mcode-tools.js`, which runs `configureWebuiMcodeToolsChildEnvironment` and imports the
embedded CLI — at which point the child sees `MCODE_AUTH_PROVIDER=shared-broker`. No external
launcher has to provide the broker variables any more; the earlier finding that nothing set them is
resolved by this path.

The remaining gate is the feature switch: `requestedMcodeTools` comes from
`beta.mcodeTools`, whose default visibility is `"none"` (`packages/config/src/config.ts`), with a
dev-build exception when `mcodeToolsDevMode` is `"published"`. Read the readiness category the
integration reports (`disabled` / `ready` / a failure class) rather than the beta flag alone.

Two things about this remain **unverified**:

- **Discovery is a separate seam.** Connector tools are not injected into the tool list; the model
  has to learn to run `mcode-tools connector tools`, which in practice means loading the
  `mcode-tools-master` skill. Making the CLI work does not make the model reach for it. The original
  investigation observed this on a persisted transcript; no run on the current build has been
  recorded.
- **No access-control decision exists.** A loopback-reachable browser surface with the connector
  broker can call every App the user has connected on this machine. That is the same class of
  concern ADR 0004 addresses by binding loopback-only, and it is not covered by an ADR. See
  `open-questions.md`.

## 2. Services gated to the Electron owner

These branch on `runtimeOwnerKind` outside the policy system, so no change to the WebUI's row reaches
them. They are listed so a future reader does not rediscover them as wiring gaps:

| Site | Gate | What the WebUI does not get |
| --- | --- | --- |
| `local-runtime-v2/src/service/miniapp/composition.ts` | `runtimeOwnerKind !== 'electron'` → `undefined` | The miniapp service |
| `local-runtime-v2/src/runtime.ts` (`greetingEnabled`) | `runtimeOwnerKind === 'electron'` | The startup greeting |
| `local-runtime-v2/src/service/llm-context-inspector/initialize.ts` | `runtimeOwnerKind === 'tui'` plus `MAVIS_TUI_LLM_CONTEXT_INSPECTOR=1` | The context inspector (the terminal client can opt in; the WebUI cannot) |

The miniapp and inspector gates are service-availability decisions, not client-policy bugs.

## 3. The data directory is displayed, not relocated

`client/features/settings/ui/SettingsModal.tsx` renders the data directory as static text. There is
no relocation surface. Implementing one needs a host lifecycle change and a credential-preservation
story, because the directory is shared with the terminal client (ADR 0006) and carries the login
state.

## 4. Settings tabs that are declared but disabled

`client/features/settings/projection/settings-view.ts` declares `voice`, `shortcuts` and `connection`
with `disabled: true`. They render as tabs that cannot be opened. That is the shipped state, not a
regression.

## 5. Upstream open results need runtime conversion

The host assembly no longer casts the runtime host. Harness adapters derive host-facing types
from public `CliService` methods and convert them into independent WebUI DTOs; semantic readers
retain those types. Ten upstream methods still declare `unknown` results, so their adapters need
runtime conversion rather than a stronger inferred contract. The exact set is pinned in
`test/unit/webui-host-contract-derivation.test.ts`; see
[`runtime/harness-boundary.md`](runtime/harness-boundary.md).

## 6. The submission record carries a decision nothing reads

`client/features/turn/contracts/submission.ts` defines a submission's record as
`{id, decision, completion}`. `client/features/turn/application/composer-submission.ts` derives the
decision from the completion so the two cannot disagree, and the caller consumes the transition it
returns. A grep across `packages/webui/src` finds no production read of `operation.decision`; ADR 0018
records the same thing as an unimplemented contract detail (the promise-shaped `decision`/`completion`
pair described by the cohesion plan was never built). Whether the field needs a reader, or should
stop being written, is undecided.

## 7. There is no scheduled-task surface

The WebUI-owned scheduler was removed in full on 2026-10-09: the panel, its operations, the port, the
in-process tick loop and its `<dataDir>/webui/scheduled-tasks.sqlite` store are gone, along with the
`better-sqlite3` dependency they introduced. The runtime-owner row enables `schedulerHost` and
`cronService` for this client, but nothing in the browser surfaces them, and no plan exists to
restore the removed surface (the retirement decision is in the branch history).

## 8. A web tab can name only the isolated Chromium

The tab model ([ADR 0022](adr/0022-webui-workspace-panel-is-a-browser-tab-strip.md)) is in the tree.
The workspace panel's tab strip holds tool tabs and web tabs, the isolated Chromium holds one page per
web tab, and the Agent's `open_tab` opens a page and makes it the run's selection. The four gaps this
entry used to list are closed: the Agent can acquire a selection, the provider drives a page per web
tab, the frame stream is per target, and a tab is a stable id with a mutable content.

What remains is a boundary rather than a gap:

- **The extension bridge implements no `open_tab`.** Edge and Chrome are reached through the
  extension, which drives the person's own browser through `chrome.debugger` and cannot open a page
  in it, so a web tab can name only the isolated Chromium. A person who wants a page in their own
  browser uses the browser itself; the panel's web tabs are the embedded browser's.
- **The bridged surfaces have no tab model.** The strip's web tabs come from the isolated
  Chromium's snapshot, and the bridge's pages are not published as tabs.

## 9. The Mini App capability is not reachable from this client

The runtime owns a Mini App service — a supervisor, a node runtime that spawns the Mini App's own
process, a plugin package reader, and a session Mini App lifecycle. None of it is reachable from
the WebUI:

- `local-runtime-v2/src/service/miniapp/composition.ts` returns no options unless the runtime owner
  kind is `electron`, so in the WebUI process the Mini App supervisor is never initialized and
  `miniappAvailable` is false.
- `CliService` has no Mini App method, so there is no client entry for the capability the runtime
  already owns in `application/session/process-local-miniapp-application.ts`.
- The client has no Mini App view, no proxy, and no page bridge.

The Mini App contract in this repository is also one generation behind the implementation shipped
in the desktop client: `packages/shared/src/miniapp-surface.ts` here is 54 lines against 1267
there, and this repository's runtime has no credential guard on the Mini App's own HTTP server.
The newer contract is in neither this repository nor the public upstream tree, so it does not
arrive by synchronization. The accepted direction for this client is in
[ADR 0020](adr/0020-webui-miniapp-view-and-runtime-seams.md), including the contract-baseline
question it leaves open.

The owner-kind gate is also decided in the wrong place. The runtime owner policy resolves once per
host and drives the other owner-derived service gates — cron, channels, the scheduler — from its
cells, while the Mini App gate compares the raw kind string inside its own service
(`local-runtime-v2/src/service/miniapp/composition.ts`). That is why §2 lists it as a branch no
change to this client's row can reach. The accepted shape moves the Mini App service into the
policy as a wiring cell this client's row carries.

## 10. A symlink out of the workspace is not detectable by the diff boundary

**Implemented, with a stated limit.** A turn's diff can name a file outside the workspace, and the
client now withholds that file's body: the entry keeps its name, its status and its line counts,
and the surface says the content is not shown. The decision and its reasoning are in
[ADR 0024](adr/0024-the-client-draws-the-workspace-boundary-for-a-diff-body.md).

What the boundary cannot do is tell a **symlink inside the workspace that points outside it** from
an ordinary file. The entry's path is a relative one, so it stays contained, and the browser has no
filesystem to resolve it against. Closing that needs `realpath` on every target, with careful
handling of files that do not exist yet, on the runtime side — which is also where the reverted
upstream fix would have had to live. The unit test says so out loud rather than leaving it to be
discovered.

Two further limits are stated rather than hidden, and both are deliberate:

- The comparison is **lexical**. It reads the path as written; it does not resolve it.
- A diff entry is only withheld when the client **knows** the workspace root. Without one the
  entries are shown as they are, because a check that hid everything it could not place would hide
  ordinary content too.

The upstream half of this is still open: the fix that stopped the runtime from *collecting* an
out-of-workspace file's content was reverted in PR #240 because it changed a package this fork may
not change, so the content still travels between the runtime and the browser. The client stops it
from being shown; only the upstream change stops it from being collected.

## Reported as missing, and actually correct

- **The thirteen runtime-owner cells are not read by this package.** That is expected: they are
  consumed by the harness. Searching `packages/webui/src` for each cell name returns nothing, and
  nothing should change that. See [`runtime/owner-identity.md`](runtime/owner-identity.md) for the
  row itself.
- **`capabilityProfile` is not set.** The `webui` row accounts for it directly; dropping it is
  deliberate.
- **There is no `/login` or `/onboarding` route.** `client/projection/common/router.ts` declares
  `archon` and `404` only; sign-in is an in-app dialog
  (`client/features/account/ui/AccountLoginDialog.tsx`). Older plans named four pages; the shipped
  client has two routes.
