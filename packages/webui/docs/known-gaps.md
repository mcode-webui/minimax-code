# Known gaps

Capabilities the WebUI does not have, verified against the tree. Each entry says what was checked,
how, and what remains unverified. "Not implemented" and "not decided" are different states and are
kept apart here; the undecided ones are also in `open-questions.md`.

Last verified: 2026-10-27, against `webui` at `d9593276` with the Mini App hosting stack
from `origin/webui` at `ba946c06`. This list covers capabilities; open
decisions are in [`open-questions.md`](open-questions.md).

## 1. Connector and App tools depend on a beta feature, and on the model finding them

**Implemented, not reachable by default.** The chain is complete and self-contained: the assembly
prepares the integration (`runtime/mcode-tools.ts`), which creates a runtime directory, **starts its
own auth-lease broker** and then installs the host-only keys through
`activateWebuiMcodeToolsEnvironment`. The child launcher (`server/internal-bin/mcode-tools`, copied
by `scripts/build-webui.mjs`) execs `server/mcode-tools.js`, which runs
`configureWebuiMcodeToolsChildEnvironment` and imports the embedded CLI — at which point the child
sees `MCODE_AUTH_PROVIDER=shared-broker`. No external launcher has to provide the broker variables
any more; the earlier finding that nothing sets them is resolved by this path.

**The bundled CLI and the host environment are independent.** What authenticates a mcode-tools run
is the broker, never the bundled binary: the Agent runs whatever `mcode-tools` resolves to on
PATH, and the host keys (`__MAVIS_MCODE_TOOLS_BROKER_ENDPOINT`,
`__MAVIS_MCODE_TOOLS_BROKER_CAPABILITY_FILE`, `__MAVIS_MCODE_TOOLS_RUNTIME_EXECUTABLE`,
`__MAVIS_MCODE_TOOLS_CONFIG_DIR`, `__MAVIS_MCODE_TOOLS_REGION`) are what let that run
authenticate. The integration therefore starts the broker even when the bundled resource is missing
or does not match the build environment, and the readiness reports the two facts apart: `ready`
(host environment live, and this client also ships the CLI it would host) and
`resource_unavailable` (host environment live, no usable bundled CLI). The Agent in a client
without a bundled CLI drives the mcode-tools CLI installed elsewhere on the machine, and it
authenticates against *this* client's broker instead of scavenging another host's broker out of the
data directory.

Two different facts are involved, and the assembly keeps them apart. The **capability switch**
`beta.mcodeTools` is the configured intent, and it stays at its resolved value
(`packages/webui/src/runtime/assembly.ts`): the WebUI no longer overwrites it with the readiness,
which is what used to drop the `mcode-tools-master` skill from the catalog and leave the Agent
without any entry point for multimodal generation. The **readiness** category the integration
reports (`disabled` / `ready` / a failure class) says whether *this* client can host the
integration right now; read it separately when diagnosing the broker.

Verified: `packages/webui/test/integration/real-host-skill-catalog.test.ts` boots the real host
in an isolated data directory, runs one turn against a stub model, and asserts that the rendered
`<available_skills>` catalogue carries `mcode-tools-master` while the integration reports
`ready: false` — and drops it when the capability switch is off.

Verified: `packages/webui/test/integration/webui-mcode-tools-host-environment.test.ts` starts the
real broker in an isolated data directory with no bundled CLI next to the entry, and runs the lease
client as a **separate process** that inherits only the installed host keys. The child projects them
into the public contract and leases a token from this client's broker; the same child without the
keys refuses, which is the control that shows the keys are load-bearing.

Verified: `packages/webui/test/integration/real-host-mcode-tools-bash-environment.test.ts` boots the
real host with the real integration — no stubbed preparation — drives one turn in which the Agent's
Bash reads the host keys back, and asserts that the **Bash subprocess** carries the broker
endpoint and the capability file. That is the half a host-environment test alone cannot prove: the
keys have to survive the runtime's environment build and the Bash tool's two-layer sanitizer.

**Still open:** the dev environment still ships no bundled mcode-tools CLI of its own
(`packages/webui/src/runtime/mcode-tools.ts` maps every non-prod build env to `test`, while the
only obtainable artifact is a prod build, and only the packaged build copies the embedded host that
the dev server lacks). The skill is back in the catalogue and the broker is up, so the commands
behind the skill run against the mcode-tools CLI installed elsewhere on the machine — but a dev
client on a machine without one has no CLI to drive.

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
| `local-runtime-v2/src/runtime.ts` (`greetingEnabled`) | `runtimeOwnerKind === 'electron'` | The startup greeting |
| `local-runtime-v2/src/service/llm-context-inspector/initialize.ts` | `runtimeOwnerKind === 'tui'` plus `MAVIS_TUI_LLM_CONTEXT_INSPECTOR=1` | The context inspector (the terminal client can opt in; the WebUI cannot) |

The inspector gate is a service-availability decision, not a client-policy bug. Mini App service
availability is driven by the runtime owner's `wiring.miniAppService` cell, including the WebUI row;
the service composition no longer compares `runtimeOwnerKind` directly.

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
- **The bridge cannot `upload_files`.** The action needs `DOM.setFileInputFiles`, which is
  deliberately absent from the extension's DevTools allowlist — the extension's debugger could run
  it, but what it must not do is give the Agent a way to name an arbitrary local file in the user's
  real browser. The action therefore cannot complete on the bridge: the extension refuses the
  method as unsupported, and the bridge maps that refusal to `browser_capability_denied`. This is a
  **capability difference, not a semantic one**: the isolated Chromium performs the same action
  with the same semantics. **No test pins the refusal**, so a future change to the allowlist would
  silently widen this surface.

The bridge's **restricted action set is otherwise the same 28 actions** the isolated Chromium
executes, and both are executed by Browser Core — one implementation over two transports. See
[`browser-use/10-browser-core-integration.md`](browser-use/10-browser-core-integration.md).

## 9. A symlink out of the workspace is not detectable by the diff boundary

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

## 11. The collapsed rail renders no navigation, and the rail's grip does nothing

**Shipped state, not a regression.** Two affordances in the shell look like they do something and
do not.

- **The collapsed rail is 64px of nothing.** `client/features/sessions/ui/SessionRailRegion.tsx`
  renders the rail's fixed rows, its scroll area and its project list only when `collapsed` is
  false. In the collapsed state the aside keeps its 64px width, a 50px spacer and the footer, and
  no navigation item at all. Collapsing the rail therefore does not replace the navigation with an
  icon rail — it removes it, and the only way back is the toggle in the session header.
- **The rail's grip is decoration.** The separator on the rail's edge in
  `client/shell/WebuiClientFoundationApp.tsx` carries `role="separator"`,
  `aria-label="Resize navigation"` and a visible grip, but no pointer or keyboard handler. The rail
  is not resizable.

[ADR 0025](adr/0025-the-layout-adapts-to-available-width.md) keeps both as they are and changes only
*when* the rail changes form: below 640px it becomes an overlay drawer instead of a column. Giving
the collapsed state an icon rail, and making the grip real, are each a separate piece of work.

## 12. The progress panel is unavailable below 1080px

**Deliberate, and the card's own doing.** The progress panel is a card that floats over the
conversation's right edge, and the conversation keeps a 312px gutter for it so the card lands in
that gutter instead of on top of the text. Below 1080px the conversation cannot spare that gutter
without being squeezed itself, so the panel closes itself: the card would otherwise float over the
conversation's corner and cover the messages it is reporting on.

The cost is real and worth stating: **on a window narrower than 1080px there is no progress
panel at all.** The control in the session header stays in place, marked unavailable and
explaining why, rather than opening a card that would cover the text. Widening the window past
1080px brings the control back but does not open the panel by itself — it opens by hand.

The alternative — keeping the card and letting the conversation yield the width — would give the
panel back at the cost of 312px of reading space on every narrow window. The conversation is the
thing the client is for, so the panel gives way instead. [ADR 0025](adr/0025-the-layout-adapts-to-available-width.md)
records the decision.

## The capability surface is pinned by a gate

Built-in capabilities have gone missing three ways, and every one of them was invisible until a
turn failed: a skill dropped out of the rendered catalog, a native tool missing from the tool
table, an MCP server's tools never reaching the model. Each of those happened here, and each was
found by hand.

`packages/webui/test/integration/real-host-capability-surface.test.ts` watches the surface a real
turn offers the model — the rendered `<available_skills>` catalog and the tool table of the model
request — and pins it to a reviewed baseline
(`packages/webui/test/integration/capability-surface-baseline.ts`). The host is the production one,
booted in an isolated data directory, and the MCP part of the surface is earned through a real
stdio server (`mcp-capability-fixture-server.mjs`), so a server that fails to connect cannot pass.

The baseline is a frozen snapshot rather than a derived expectation. Deriving it from the
implementation would make the gate tautological: dropping a registration would drop the
expectation with it. A capability that disappears fails the gate, and so does one that appears —
until the baseline is updated on purpose, which shows up as a reviewable diff.

The snapshot is taken under a pinned configuration — region, build environment, the beta switches,
and the external skill roots switched off — because the catalog otherwise depends on the machine:
the external roots scan the user's home, and the region decides which built-in skills are offered.
Three built-in skills are deliberately outside the snapshot, each behind a gate this configuration
does not meet (`cu-desktop`, `control-in-app-browser`, `resume-codex`); if a later change turns
one of them on for this client, the gate fails on the extra entry, which is the point.

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
