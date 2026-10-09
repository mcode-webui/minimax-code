# WebUI client identity: a plan

How `packages/webui` gets a formal, testable client identity in the harness
layer, and what it costs.

Status: **proposal, reviewed.** Six rounds of defect-hunting by one model, then
two rounds of architecture direction by another. Every round found real defects
and all are fixed. Corrections are recorded rather than quietly applied, because
several of them invalidate claims an earlier version of this document made.

## Scope and constraints

This work **does not go upstream**. The WebUI lives on a separately maintained
branch; harness edits are made directly in this repository. There is no pull
request to the upstream projection and no three-way-merge cost to amortise.

That constraint removes the single strongest argument against touching the
harness: "every edit is a recurring merge". Design decisions rejected on that
basis are re-opened here.

### The harness/WebUI boundary for this change

**This change touches `packages/local-runtime` and `packages/local-runtime-v2`
only. It edits nothing in `packages/webui`.**

**What the exit condition claims.** The harness change is complete when it
resolves `runtimeOwnerKind: 'webui'` to a policy that assembles the declared
services, and a test constructs that host to prove it.

**What it does not claim.** It does not establish that WebUI declares that
owner, nor that the WebUI's UI receives the expected capability. A
harness-only test can prove the harness handles a `webui` owner; nothing in
this change proves a client uses it. Claiming "WebUI is a first-class client"
requires the declaration change plus a WebUI-level integration check, both
deferred below. Stating the boundary this narrowly is what makes the split
reviewable rather than a partial claim.

Deferred to the WebUI-side changes:

- flipping `packages/webui/src/server/assembly.ts` to
  `runtimeOwnerKind: "webui"` and dropping `capabilityProfile`;
- the cron panel migration (ADR 0012 retirement), which needs WebUI's own
  SQLite store and tick loop torn down;
- reconciling `packages/webui/src/server/profile-files.ts` with the harness
  memory service;
- the integration check that would justify the larger claim;
- correcting the ADR 0004 misattribution at `assembly.ts:368-369` and
  `webui-service.test.ts:3190`.

Not in scope at all: the WebUI runtime layer, the `.minimax/webui/` data
directory layout, and WebUI-side auth consolidation.

## Problem

`runtimeOwnerKind` is a single string that more than twenty call sites read.
Each decides, independently, what the value means. The readings do not agree:

| Site | Predicate | Reading |
| --- | --- | --- |
| `local-runtime-v2/src/runtime.ts:843` | `=== "electron"` | "am I a desktop" (rejects `undefined`) |
| `local-runtime-v2/src/services.ts:493,499` | `ownsElectronRuntimeCapabilities()` | "am I a desktop" (accepts `undefined`) — drives cron **and** channel |
| `local-runtime-v2/src/application/agent/profile-source.ts:104` | `isCommandLineRuntimeOwner()` | "am I a degraded runtime" — duplicated verbatim at `application/session/task-agent-binding-capture.ts:738` |
| `local-runtime/src/api/hosted-agent-capability-factory.ts:18` | `isCliRestrictedRuntime()` | "am I a degraded runtime" — but also requires `cliEmbedded === true` |
| `local-runtime/src/api/host.ts:1396` | `!== "tui"` | "am I allowed memory" |

Three sites encode "am I a desktop"; two encode "am I a degraded runtime";
neither set is a subset of the other. A new value lands in a bucket nobody
designed, and the fall-throughs disagree:

| Predicate | An unrecognised owner gets |
| --- | --- |
| `isV2RuntimeOwner` (`runtime.ts:535-543`) | **nothing** — the whole V1 compatibility layer is dropped |
| `isUserMemoryCapabilityAvailable` (`host.ts:1396`) | **memory granted** |
| `isCronCapabilityAvailable` (`host.ts:1384-1393`) | **cron adapter requested** |
| `profile-source.ts:49` prompt profile | silently `desktop` |
| `agent-prompt-surface.ts:31` | silently `interactive` |

So `'webui'` today would gain memory and cron and silently lose the
questionnaire service.

## Two further findings

### `capabilityProfile: 'cli'` is a product-tier switch, not a client name

`local-runtime-v2/src/application/agent/profile-source.ts:73-83` sets
`features.mavis = false` when the profile is `'cli'`, which then drives
`service/agent/builtin/prompt-renderer.ts:29,36,37`. `host-factory-types.ts:33-34`
documents the field as *"Omitted hosts retain the shared Desktop/legacy
surface"* — an opt-in downgrade.

### `buildLocalRuntimeSurfaceCapabilities` is a table that already lies

`local-runtime/src/runtime/mode.ts` defines a 42-key vocabulary with `status`
and `reason`. `buildLocalRuntimeSurfaceCapabilities(mode)` (`mode.ts:127-129`)
begins with `void mode;` and returns a constant table.

It contradicts its own gating: it reports `cron: { status: 'native' }`
(`mode.ts:180-183`) and `channelBridge: { status: 'native' }`
(`mode.ts:162-166`) on a host where `enableCron` is false and
`capabilityProfile: 'cli'` disables channels.

**Risk assessment, corrected twice.** An earlier draft called this "a contract
change with an external consumer", implying runtime risk. A full sweep shows
**`surfaces` has no reader that decides anything**: its only readers are
`api/host.ts:1518,1545`, both feeding `buildRuntimeDoctorSnapshot`, and
`api/host-support.ts:838,1242`, both inside status-document builders. The only
in-tree caller of `getProcessLocalRuntimeDiagnostics()` is
`local-runtime-v2/src/compat/v1/runtime.ts:737`. No test references
`LocalRuntimeSurfaceKey` or `agent.cron`.

So correcting it changes a diagnostics document and nothing else. Calling it
"the cheapest high-value phase" was also wrong — those two claims cannot both
hold. It is **safe, boring, and not high-value**, and should not carry its own
justification.

## Root cause: deliberate intent, accreted mechanism

The restriction itself is documented and intentional
(`api/hosted-agent-capability-factory.ts:10-12`):

> memory and CU are unavailable there. **This is the single source of truth for
> "this host is a restricted command-line runtime"** — reused by the reminder
> pipeline so prompt guidance cannot drift from the capability matrix.

What accumulated around it:

1. **The "single source of truth" does not survive the package boundary.**
   `isCliRestrictedRuntime(kind, cliEmbedded)` requires `cliEmbedded === true`;
   `isCommandLineRuntimeOwner(kind)` does not.
2. **`ownsElectronRuntimeCapabilities` has no doc comment** and is reused for
   three unrelated decisions while accepting `undefined`, which `runtime.ts:843`
   does not.
3. **`'electron' | 'cli' | 'tui' | string` (`host-factory-types.ts:32`) collapses
   to `string`.** It documents forward compatibility and enforces nothing.
4. **The field carries two welded jobs.** WebUI moved from `'cli'` to `'tui'` to
   obtain a different prompt template (`webui-tui-harness-migration.md:67`), not
   to change its deployment class.
5. **The WebUI's harness commits are capability supply, not gating workarounds.**
   Each of the five predicate files — `profile-source.ts`,
   `runtime-browser-use-composition.ts`, `hosted-agent-capability-factory.ts`,
   `mode.ts`, `host-contract.ts` — has **exactly one commit**, the initial
   snapshot `c59cf53`. None of the WebUI's commits touch them.

Historical note: this repository has 599 commits, but the harness arrived in a
single `Import MiniMax Code CLI source snapshot` (`c59cf53`, 2026-09-18). Claims
about *when* a divergence appeared are inference from code shape and comments,
not from history.

## Proposal

### The policy resolver

**Where it lives.** `packages/local-runtime/src/runtime/runtime-owner-policy.ts`
— alongside `host-factory-types.ts`, which declares `runtimeOwnerKind` itself,
and `mode.ts`, which declares the capability and surface vocabularies.

An earlier draft placed it at
`local-runtime-v2/src/application/agent/runtime-owner-classification.ts`. **That
was impossible.** `packages/local-runtime-v2/package.json:96` depends on
`@mavis/local-runtime`, and `local-runtime` does not depend on v2, so a consumer
in `local-runtime/src/api/` — the v1 host, which reads the owner kind at
`host.ts:455,1396` — could not import it.

**What it is called.** `resolveRuntimeOwnerPolicy`, not `classifyRuntimeOwner`.
The inputs are `cliEmbedded`, `electronHost` and `capabilityProfile` — host
configuration, not an owner label — so "classify" described a narrower thing than
the function does.

```ts
/** Known owner kinds. 'runtime' is the string `api/host.ts:706-708` substitutes
 *  for an absent owner. It is a declared row, not a fallback. */
export type RuntimeOwnerKind = 'electron' | 'cli' | 'tui' | 'webui' | 'runtime';

/** Resolution rows. 'absent' is distinct from 'runtime' on purpose — see
 *  "Owner absent versus owner named" below. */
export type RuntimeOwnerRow = RuntimeOwnerKind | 'absent';

/** What the host assembles and exposes. */
export interface RuntimeWiring {
  readonly ownsV2Runtime: boolean;      // replaces isV2RuntimeOwner
  readonly schedulerHost: boolean;      // replaces runtime.ts:843 electronOwner
  readonly cronService: boolean;        // replaces ownsElectronRuntimeCapabilities
  readonly channelService: boolean;     // also drives host.ts:455 and
                                        // host-channel-composition.ts:314-316
  readonly browserActivation: 'desktop-plugin' | 'explicit-config';
}

/** How agent execution behaves. */
export interface AgentExecutionPolicy {
  readonly restricted: boolean;         // replaces isCliRestrictedRuntime
  //   -> disableMemory + disableCron + disableComputerUse, indivisible today
  readonly memoryFeature: boolean;
  readonly mavisFeatureBundle: boolean; // replaces capabilityProfile === 'cli'

  /** ONE decision with two consequences that today hang off the same flag on
   *  adjacent lines of one call site:
   *    'tui'     -> deferInputReviewResolution (executor.ts:338)
   *              -> contentReviewRequired, with streamUnreviewedOutput when not
   *                 required (turn-execution-policy.ts:33-38)
   *    'cli'     -> contentReviewRequired only (:41-43)
   *    'neither' -> {}
   */
  readonly reviewPolicy: 'tui' | 'cli' | 'neither';
  readonly executesTerminalControl: boolean; // executor.ts:141 -> plugin-hooks.ts:96-110

  readonly promptProfile: 'desktop' | 'tui';            // profile-source.ts:49
  readonly promptSurfaceDefault: 'interactive' | 'cli';  // agent-prompt-surface.ts:31
  readonly titleSafetyBypass: boolean;                  // session-title-policy.ts:31-44
}

export interface RuntimeOwnerPolicy {
  /** Reporting label. Kept as `?? "runtime"` so metrics and diagnostics are
   *  unchanged, even though the *resolution row* for an absent owner differs. */
  readonly kind: string;
  readonly wiring: RuntimeWiring;
  readonly execution: AgentExecutionPolicy;
}

/**
 * Every input is consumed by a returned cell, or it does not belong here:
 *   cliEmbedded       -> wiring.ownsV2Runtime   (runtime.ts:541)
 *                      -> execution.restricted   (hosted-agent-capability-factory.ts:18)
 *   electronHost      -> wiring.ownsV2Runtime   (runtime.ts:538)
 *   capabilityProfile -> execution.mavisFeatureBundle (profile-source.ts:38)
 */
export function resolveRuntimeOwnerPolicy(input: {
  readonly kind: string | undefined;
  readonly cliEmbedded: boolean;
  readonly electronHost: boolean;
  readonly capabilityProfile: 'cli' | undefined;
}): RuntimeOwnerPolicy;
```

### Why two groups, and why one function

An architecture review asked whether the cells were one concept and answered:
**not redundant is not the same as one concept.** Cells can be distinct and
still belong to different policies. The test that separates them: *would a
consumer ask for this value as part of the same decision, from the same
authority, under the same change conditions?*

Wiring cells answer *what the host assembles and exposes*. Execution cells
answer *how a turn behaves*. The split is in the type, not in prose.

**It stays one function for now**, because both groups resolve from the same
owner and host inputs. Split into two functions only if they acquire independent
inputs or lifecycles.

**The grouping only holds if consumers use the right group.** If the descriptor
gets flattened, or a call site reconstructs policy from `kind`, the groups
become documentation. That is the failure mode to watch for in review.

The 42-key surface table is a **reporting** vocabulary. Recording availability
there does not make it authoritative for wiring — which is why availability
cells were not moved into it, and why this policy must not become a second
surface catalog.

### What the shape review changed: seventeen cells → thirteen

The first version had seventeen cells in one flat object. Two things were wrong
with it, and the review separated them.

**Cut — `legacyCliProfileRestrictions`.** It sits *inside* the `restricted`
branch (`hosted-agent-capability-factory.ts:27-41`: `cliRuntime ? { …,
...(capabilityProfile === 'cli' ? { … } : {}) }`), so it can only be true when
`restricted` is true. WebUI's row has `restricted: false`, which makes the cell
structurally dead for it. The legacy `'cli'` row keeps its existing literal.

**Cut — `miniapp`.** `miniapp/composition.ts:32` reads
`if (runtimeOwnerKind !== undefined && runtimeOwnerKind !== 'electron') return undefined`.
That is **service availability, not client policy.** It also repeats the
`undefined ⇒ electron` pattern — the root defect's third appearance here.

**Merged — `inputReviewDeferred` and `contentReviewBranch` → `reviewPolicy`.**
`executor.ts:338` and `turn-execution-policy.ts:33` are adjacent branches on the
same flag in the same call site. One decision, two consequences; two booleans
also permitted the meaningless combination "legacy-CLI review required *and*
unreviewed output streams".

**Not merged — `promptSurfaceDefault` and `sessionTitleBypass`.** An earlier
draft merged these into one `localMetadataFlow` cell because they share the
literal predicate `kind === 'cli' || kind === 'tui'` (`agent-prompt-surface.ts:31`
and `session-title-policy.ts:31-34`). **That merge was wrong.** An identical
predicate proves shared *implementation*, not a shared *decision* — prompt-surface
default and title-safety bypass are different effects that may legitimately need
to diverge. A shared predicate is a refactoring opportunity, not evidence that
the policy is one thing. They stay separate cells, and the redundancy shortcut
is withdrawn: the merge of `reviewPolicy` survives on the strength of a
three-way branch, not on shared syntax.

### Cells that are not owner properties at all

**`contentReview`.** Its value today is `getRuntimeRegion() === "cn"`
(`services.ts:1007`), region is env-driven with an `"en"` fallback, and WebUI
sets `MAVIS_REGION` itself. As a per-client constant set to `true` it would
**force China-region content review onto `en`-region WebUI hosts** and flip
`streamUnreviewedOutput` — a live behaviour change inside a row labelled
"preserve".

**`remoteSkillHub`** needs `capabilities.electronHost` and environment
(`host-factory.ts:317-326`). **`llmContextInspector`** needs kind, an env opt-in
*and* a build variant (`service/llm-context-inspector/initialize.ts:36-39`).
**`sourceProvenance`** is a field for a constant:
`resolveSourceProvenanceEnabled` (`packages/shared/src/source-provenance.ts:17`)
returns a hardcoded `false` pending investigation of main-thread stalls.

None is a property of the client. All stay as their existing expressions.
`contentReviewEnabled` therefore stops being a descriptor cell and becomes a
local expression in `services.ts`; phase 3 must state where it comes from, or
the spread at `services.ts:1001-1008` has no source for it.

### `capabilityProfile` has five read sites for four effects

This was the defect that would have shipped a silent capability grant. An
exhaustive sweep — including destructured and pass-through forms — finds five
read sites, because one effect is implemented twice:

| Site | Effect | Cell |
| --- | --- | --- |
| `profile-source.ts:78` | `features.mavis = false` | `execution.mavisFeatureBundle` |
| `task-agent-binding-capture.ts:344` | `features.mavis = false` — **the same effect, implemented a second time** | `execution.mavisFeatureBundle` |
| `host.ts:455` | `channelCapabilityEnabled = capabilityProfile !== "cli"` | `wiring.channelService` |
| `host-channel-composition.ts:314-316` | `channelCapabilityPolicy: 'disabled'` | `wiring.channelService` |
| `hosted-agent-capability-factory.ts:35-41` | `disableMavis`, `disabledBuiltinSkillNames`, `resumeCodexAvailable` | **no cell** — nested inside `restricted`, cut above |

Two implementation traps:

- **The duplicated `mavis` gate must move twice.** Both sites spell out
  `features: { ...configured?.features, mavis: false }`. Converting one leaves the
  profile and the Task-capture path disagreeing — the same class of bug as
  `isCliRestrictedRuntime` versus `isCommandLineRuntimeOwner`.
- **Pass-through sites are not new effects.** `runtime-agent-product.ts:174`
  forwards into `createV2AgentProfileSource`, and
  `task-agent-ready-inventory.ts:62-63` forwards into
  `TaskAgentBindingCaptureOptions`, read only at
  `task-agent-binding-capture.ts:344`.

**Channels are governed by two independent switches today** — owner kind
(`services.ts:499`) and `capabilityProfile` (`host.ts:455`). The first draft
modelled only the first and wrote "drop `capabilityProfile`" as the flip
instruction. Following it sets `channelCapabilityEnabled` to **true** while the
row table says `channelService: false`. Hence one cell driving two sites, and
the flip must not drop `capabilityProfile` until every one of the five sites
reads a cell.

**The `'cli'` row describes `tui` and `webui` today, not a hypothetical client.**
`packages/tui/src/runtime/embedded-host.ts:88` declares
`runtimeOwnerKind: 'tui'` with `capabilityProfile: 'cli'`, and WebUI mirrors it.
The `'cli'` row must reproduce what both do now; `webui` is the first client to
leave it.

### `tuiProductPolicy` splits, and one split fixes a real bug

`executor.ts:141-143` emits `terminalSequenceSurface: 'tui' as const` whenever
the flag is true, and `assembly/local-turn-plugin-hooks.ts:96-110` uses it as a
binary switch, not a label:

```ts
reporter.terminalSequenceSurface === 'tui'
  ? { category: 'terminal-control', message: '', terminalSequence: decision.terminalSequence }
  : { category: 'terminal-control',
      message: 'A Plugin Hook requested terminal control output, but this
                runtime surface does not execute terminal control sequences.' }
```

So the field is a capability. Widening its type to admit `'webui'` — the first
draft's plan — would work only because `=== 'tui'` happens to become false, and
it would grant the wrong branch. The cell is `executesTerminalControl: boolean`.

**This fixes a latent bug.** WebUI today sets `tuiProductPolicy: true`, so it
reports `'tui'` and receives plugin-hook terminal control sequences a browser
client cannot execute. `executesTerminalControl: false` takes the explanatory
branch instead.

`cliProductPolicy` is not modelled, and that is safe only because every
declaration in use resolves its observable consequences through a cell. It is
unobservable whenever `tuiProductPolicy` is true: the `tuiProductPolicy` branch
returns first (`turn-execution-policy.ts:33`), `executor.ts:141,338` key on it
alone, `executor.ts:390` evaluates `cliProductPolicy !== true ||
tuiProductPolicy === true` to `true` either way, and
`native-production-dependencies.ts:230` evaluates `cliProductPolicy === true &&
tuiProductPolicy !== true` to `false` either way. An earlier draft concluded
this made `cliProductPolicy` droppable and wrote "the legacy `'cli'` client keeps
its own row, so its state is still expressed". **There was no cell for it.**
That sentence survives only because `reviewPolicy` now carries the branch's
observable result.

### Enforcement that actually works

1. **`RuntimeOwnerKind`** is a closed union with a `never` check — total over the
   known values.
2. **`'runtime'` is a declared row, not a fallback.** `api/host.ts:706-708`
   produces it, so routing it through the guard would make phase 1's test assert
   the guard's shape and freeze an accident into a contract.
3. **`'test'` is the opposite case.** It appears only in
   `local-runtime/test/unit/local-output-safety-writer-v2-guide-review.test.ts:266`,
   is not a union member, and resolves through the guard. Phase 1 must test it
   explicitly, because a guard value differing from what that test exercises
   today is a behaviour change hiding in a test-only path.
4. **The guard has two postures**, because a uniform one is wrong in both
   directions. For an unrecognised owner today the compat layer is *dropped*
   while memory is *granted* and cron is *requested*. So:
   - **fail closed on grants** —
     `wiring`: `ownsV2Runtime: true`, `schedulerHost: false`,
     `cronService: false`, `channelService: false`,
     `browserActivation: 'explicit-config'`; `execution`: `restricted: true`,
     `memoryFeature: false`, `mavisFeatureBundle: false`,
     `reviewPolicy: 'neither'`, `executesTerminalControl: false`,
     `promptProfile: 'desktop'`, `promptSurfaceDefault: 'interactive'`,
     `titleSafetyBypass: false`;
   - **fail open on wiring** — `ownsV2Runtime: true`, so an unknown client still
     gets a working host rather than a broken one.

   **Every cell is named**, because a guard that leaves cells unspecified is the
   same defect one level down.
5. **The fallback is surfaced, not just logged.** `buildRuntimeDoctorSnapshot`
   already receives descriptor input, so the doctor document is where an
   unrecognised owner becomes visible to a human.

**This guarantee is harness-internal.** WebUI's local type
(`assembly.ts:131`) and its `as unknown as` cast (`assembly.ts:426`) mean no
client is compile-time constrained. A client that declares a typo gets an
explicit unknown-owner policy, not a type error.

### Owner absent versus owner named

`runtimeOwnerKind` is **required** by `host-factory-types.ts:32` — no `?`. So an
absent owner can only arrive through a path that bypasses the type: plain
JavaScript callers, or a client casting its options, which is exactly what
`assembly.ts:426` does. That is why `api/host.ts:708` carries a defensive
`?? "runtime"`.

**Earlier drafts normalised the two together and hid a behaviour change inside
the word "normalisation".** They disagree today:

| Predicate | `undefined` | `'runtime'` | Governs |
| --- | --- | --- | --- |
| `ownsElectronRuntimeCapabilities` (`runtime-browser-use-composition.ts:40`) | **true** | false | cron, channel, browser activation |
| `isV2RuntimeOwner` (`runtime.ts:535-543`) | false | false | V1 compatibility layer |
| `isUserMemoryCapabilityAvailable` (`host.ts:1396`) | true¹ | true | memory collector |
| `isCommandLineRuntimeOwner` (`profile-source.ts:104`) | false | false | `memoryEnabled` / `cronEnabled` defer to config |

¹ `host.ts:708` coerces to `"runtime"` before storing, so `:1396` observes
`'runtime'`, never `undefined`.

**Decision: `'absent'` and `'runtime'` are distinct rows.**
`kind` keeps `?? "runtime"` for reporting so diagnostics are unchanged, while
the resolution row is `input.kind === undefined ? 'absent' : normalise(kind)`.
Collapsing them would have been a deliberate behaviour change chosen by
accident; making absence fatal would be the same thing more honestly. Neither
belongs here.

`'absent'` therefore reproduces today's raw-option answers verbatim: `wiring`
`ownsV2Runtime: false`, `schedulerHost: false`, `cronService: **true**`,
`channelService: **true**`, `browserActivation: 'desktop-plugin'`; `execution`
`restricted: false`, memory deferred to config, `mavisFeatureBundle: true`,
`reviewPolicy: 'neither'`, `executesTerminalControl: false`,
`promptProfile: 'desktop'`, `promptSurfaceDefault: 'interactive'`,
`titleSafetyBypass: false`.

> An earlier draft of this row said `cronService: false`,
> `channelService: false` and `browserActivation: 'explicit-config'`. **That was
> wrong** — it reasoned from the coerced `'runtime'` string where
> `services.ts:493` reads the raw `undefined`.

**The contradiction is recorded, not resolved.** An undeclared owner receives the
*entire desktop service surface* plus the memory collector, and loses only the
V1 compatibility layer:

| | absent owner gets |
| --- | --- |
| `services.ts:493,499` via `ownsElectronRuntimeCapabilities(undefined)` → true | cron **on**, channel **on** |
| `runtime-browser-use-composition.ts:62` | browser activation `'desktop-plugin'` |
| `host.ts:706-708` + `:1396` | memory collector **on** |
| `runtime.ts:535-543` | compatibility layer **off** — questionnaire service gone |

One line states the whole problem: **"no owner declared" is read as "assume
desktop" by the service gates and as "unknown" by the compatibility gate.**
Fixing it changes behaviour, so:

> **Named follow-up.** Decide whether an absent owner should inherit the desktop
> surface or the restricted one, then change the coercion at `host.ts:708` and
> the `'absent'` row together. Until then the row is a faithful transcription of
> an incoherence, and saying so is the point.

### Compatibility: this is not purely a safety change

The guard changes behaviour for every value outside the union. For `'test'`,
today's answers are `ownsV2Runtime: false`, memory granted,
`restricted: false`; the guard returns `ownsV2Runtime: true`, memory closed,
`restricted: true`.

It lands in **phase 3**, not phase 1: the guard is inert until a call site reads
it. But phase 3's byte-identical guarantee is stated for `electron`, `cli`,
`tui`, `runtime` and `absent` — **`'test'` is not among them, and should not
be**, because its answers genuinely change.

The same applies to callers outside this repository. An open
`'electron' | 'cli' | 'tui' | string` gives such a caller no contract — each
predicate answers independently and disagrees — so "preserve the open boundary"
preserves the absence of one. Still, the honest framing is that **this is a
compatibility decision made deliberately, not a safety win that costs nothing.**

## The WebUI row

Decided by the maintainer on 2026-10-08: `memoryFeature: true`,
`mavisFeatureBundle: true`, and Computer Use — which resolves to
`restricted: false`, since that cell cannot be taken partially.

Read this as **the places WebUI differs from `tui`**. The `tui` column is the row
WebUI inherits until the flip.

| Group | Cell | `tui` | `'webui'` | Basis |
| --- | --- | --- | --- | --- |
| — | `kind` | `'tui'` | `'webui'` | metrics / diagnostics label only |
| wiring | `ownsV2Runtime` | true *(via the `cli \|\| tui` clause)* | `true` **explicitly** | **required.** Same value, different derivation — `tui` inherits it from a clause `'webui'` is not in. `false` drops the V1 compatibility layer and the questionnaire service |
| wiring | `schedulerHost` | false | **`true`** | cron migration precondition |
| wiring | `cronService` | false | **`true`** | cron migration precondition |
| wiring | `channelService` | false | false | preserve; no `minimax://` deeplink OAuth callback here |
| wiring | `browserActivation` | `'explicit-config'` | `'explicit-config'` | preserve; WebUI owns its `browserProvider` |
| execution | `restricted` | true | **`false`** | decided; frees memory, cron and Computer Use together |
| execution | `memoryFeature` | false | **`true`** | decided |
| execution | `mavisFeatureBundle` | false | **`true`** | decided |
| execution | `executesTerminalControl` | true | **`false`** | **changes behaviour at the flip.** WebUI inherits `'tui'` today and receives terminal control sequences it cannot execute |
| execution | `reviewPolicy` | `'tui'` | `'tui'` | preserve — input review deferred, content review for managed providers, unreviewed output streams otherwise |
| execution | `promptProfile` | `'tui'` | `'tui'` | preserve |
| execution | `promptSurfaceDefault` | `'cli'` | `'cli'` | preserve |
| execution | `titleSafetyBypass` | true | `true` | **provisional.** Carried as today's effective value so the refactor does not silently change title generation — see the note below |

Six cells differ from `tui`; seven are inherited. An identity change should not
silently move turn-execution semantics, so the inherited cells are the default
and the six differences are the proposal.

`executesTerminalControl: false` also retires the optional
`terminalSequenceSurface?: 'tui'` fields at `runner/contracts.ts:221` and
`assembly/local-turn-plugin-hooks.ts:29,62`.

**On `titleSafetyBypass`, provisional means provisional.** The bypass skips
content-safety review for generated titles under an unmanaged provider
(`session-title-policy.ts:31-44`). Keeping it `true` is a compatibility choice,
not a claim about WebUI. Whether the bypass is appropriate depends on the
provider and the trust assumptions — not on whether the owner is `tui` or
`webui`. If that reasoning is later settled on different terms, this cell should
be able to leave the owner policy without unwiring anything, which is one reason
it is a separate cell and not merged with `promptSurfaceDefault`.

### Memory: how many gates, really

The memory tool mounts only when **five** terms hold
(`local-runtime/src/api/local-native-tools.ts:203-209`):

1. `input.memoryFacade`
2. `input.memoryEnabled !== false`
3. `!input.excludeAgentResources`
4. `input.memoryAgentScopeEnabled === true`
5. `memoryReadEnabled !== false || memoryWriteEnabled !== false`

plus, upstream of all of it, `!restrictions.disableMemory`
(`hosted-agent-capabilities.ts:197-198`, derived from
`hosted-agent-capability-factory.ts:31`).

Term 4 is derived, not configured:
`memory_agent_scope_enabled: profile.memoryReadAgentNames.length > 0`
(`preparation/config/local-agent-config-builder.ts:924`), non-empty only when
`canonicalBuiltin && canonicalViewName === PRIMARY_AGENT_NAME`
(`service/agent/application/agent-profile.ts:130,135`;
`PRIMARY_AGENT_NAME = 'mavis'` at `service/agent/builtin/definitions.ts:54`).

WebUI sessions take the primary agent: `WebuiCreateSessionRequest.name` is
required (`packages/webui/src/server/port.ts:166`) and the composer sends
`name: "main"` (`client/transport.ts:372,378`,
`client/projection/composer-state.ts:356`), which canonicalises to `'mavis'`
(`definitions.ts:109,113`).

**But this is not uniform across WebUI session creators.** The plugin "chat with
agent" flow passes an arbitrary name
(`client/components/WebuiClientFoundationApp.tsx:1333`) and the scheduler passes
`task.agentName` (`server/scheduled-task-scheduler.ts:405`). For those,
`memoryReadAgentNames` is `NO_AGENT_MEMORY` (`agent-profile.ts:44,137`) and term 4
fails. The "only the primary family gets memory" boundary is a composer-only
boundary, not a global one.

The background collector is a separate path:
`memory/local-data-collector.ts:122-126` needs
`memoryGloballyEnabled && isPrimaryAgent(...) && detail && isTrustedPrimaryAgentDetail(...)`,
where `memoryGloballyEnabled` derives from `host.ts:639` →
`isUserMemoryCapabilityAvailable()` → `ownerKind !== "tui"`. Changing the owner
kind opens the collector on its own. Collector and tool are governed by two
independent mechanisms.

### Computer Use: the gate is in-tree, the tools are not

`local-runtime/src/cu/gate.ts:9-17` is clean and needs no service client. After
`restricted: false`, two further conditions apply and **neither is owner-kind**:

1. `config.beta.cuMode === true` — a user-facing toggle
   (`packages/config/src/config.ts:471`, `configurableVisibility: "online"`);
2. build flags. The gate is **fail-closed**: in a `prod` build without
   `__MAVIS_BUILD_INTERNAL` or `__MAVIS_BUILD_INSIDE` it stays false.

The tool implementations are outside this tree. The CU tools are
`desktop_screenshot`, `desktop_screenshot_region` and `desktop_zoom`
(`cu/cu-screenshot-pruner.ts:31-32`, `review/context-admission.ts:23-25`); they
appear in no list this repo owns — not `AGENT_BUILTIN_TOOL_IDS`, not
`AGENT_BUILTIN_MCP_TOOL_IDS` (`packages/config/src/agent-capabilities.ts:23-41`).
`packages/local-runtime/src/cu/` holds only `gate.ts` and the pruner. Whether
CU tools appear in WebUI is not decidable from this tree.

**Security note, recorded once.** `desktop_screenshot` and `desktop_zoom`
control a physical desktop. ADR 0004 keeps the WebUI loopback with Host and
Origin validation, a per-start credential and an operation allowlist, and says
plainly that "a single local user is not the same thing as no access control".
Enabling Computer Use moves a browser-reachable client closer to that boundary.
A constraint on deployment, not an objection to the capability.

### `mavisFeatureBundle: true`

All consequences confirmed:

1. `local-native-tool-filter.ts:15` — the `mavis` tool is filtered out.
2. `local-native-tool-filter.ts:20-24` — the `task` tool's `agent_name`
   description is rewritten to drop the word "mavis".
3. `skills/feature-owned-skills.ts:27-31` — `mavis`, `create-agent` and
   `minimax-code-product` are not added.
4. `prompt-renderer.ts:29,36,37` — three template variables.
5. `service/agent/domain/validation.ts:152-155` — `mavis` and `delegation` are
   coupled, so turning the bundle on is what makes subagent creation reachable.

Point 5 is the mechanism team mode depends on: WebUI infers it client-side from
`getChildSessions(session.id).length > 0`
(`packages/webui/src/client/team-mode.ts:26`), permanently zero today because
nothing can create a child agent.

The `mavis` tool (`agent-tools/src/desktop/builtin-defs.ts:946`) declares
`agent`, `cron`, `session` and `mcp`. The `cron` group answers
`CRON_UNSUPPORTED_HOST`, because `host.ts:1376` resolves it through
`mavisCronAdapterProvider` — six references in the repository and **no
producer**. `local-mavis-cron-adapter.ts:203` exists and takes a
`CronV2GeneratedClient` (`:92-93`), but that interface is `DesktopService`-shaped
(`listModels`, `listCronDefinitions`, `createCronDefinition`) and belongs to the
packaged desktop, wired outside this tree. **The missing piece is a client for a
service this client does not speak, not a one-line hookup.** It should be filed
separately; WebUI must not become the reason a desktop-only surface gets rebuilt.

## Corrections to ADR 0012's retirement condition

ADR 0012 lists two gates. There are at least four, and the probe cannot see the
third **structurally**: `UPSTREAM_FILES`
(`packages/webui/test/unit/webui-scheduled-task-upstream-probe.test.ts:93-99`)
lists `services.ts`, `runtime-browser-use-composition.ts`, `host-contract.ts`
and `cli-service.ts` — **not `runtime.ts`**, where `enableScheduler` is assigned.
The string `enableScheduler` appears zero times in the probe.

1. `enableCron` (`services.ts:493`).
2. Reachability on `CreatedLocalRuntimeHost` (`local/host-contract.ts:72`).
3. **`enableScheduler` (`runtime.ts:851`).** `services.ts:1110-1111` throws
   `"Runtime Cron services require an owned Scheduler client."` without one, and
   the scheduler is only built when `enableScheduler !== false`
   (`background-runtime.ts:62-63`).
4. **`restricted`** — not an ADR 0012 gate at all; found afterwards.

The fix for 3 is mechanical: add `runtime.ts` to `UPSTREAM_FILES` and a third
gate check. It is WebUI-side work and therefore deferred.

## Migration order

- **Phase 0 is documentation.** Every later phase is currently performed under a
  rule — ADR 0007's harness-read-only clause — that forbids it.
- **Phase 1 is a mechanical extraction.** The extracted predicates still compare
  strings; nothing calls `resolveRuntimeOwnerPolicy` yet.
- **Phase 3 is the wiring phase, and it is byte-identical for every declaration
  in use today** — `electron`, `cli`, `tui`, `runtime` and `absent`.
- **Phases 2 and 4 are contract changes**, with corrected risk assessment.

1. **Phase 0 — ADR.** Supersede ADR 0007's harness-read-only rule. The ADR is
   harness documentation and in scope; correcting the ADR 0004 misattribution
   inside `packages/webui` is not.
2. **Phase 1 — extract the predicates mechanically.** Move the six predicates
   into one module as pure functions, still comparing strings. Table-driven test
   over existing values. *No behaviour change.* Phase 1 also introduces
   `RuntimeOwnerKind`, the `'absent'` row, the unknown-owner guard, and the test
   enumerating every value the host factory can receive including `'test'`.
   **No call site is changed in this phase**, which is what makes the
   behaviour-identical claim true rather than aspirational.
3. **Phase 2 — the surface table takes the policy**, correcting the `cron` and
   `channelBridge` rows. Per the correction above this changes a diagnostics
   document only. Ordered after phase 3 because the profile path is the one that
   must not move, and doing the observable one first would make a regression
   harder to attribute.
4. **Phase 3 — the wiring phase.** Every owner-derived call site now reads a
   cell instead of a string comparison. This covers **all** of them: `runtime.ts:535-543,843`,
   `services.ts:493,499`, `profile-source.ts:49,52,53`, **both** copies of the
   `mavis` gate (`profile-source.ts:78` and `task-agent-binding-capture.ts:344`),
   `hosted-agent-capability-factory.ts:27-42`, `host.ts:455,1396`,
   `host-channel-composition.ts:314-316`, `session-title-policy.ts:31-44`,
   `agent-prompt-surface.ts:31`, `local-agent-config-builder.ts:134,279`, and the
   product-policy readers `services.ts:767,1001-1008`,
   `runtime-session-composition.ts:104`, `runtime-agent-product.ts:167`,
   `executor.ts:141,338,390`, `turn-execution-policy.ts:30-45`,
   `hosted-agent-capabilities.ts:197-198,233`,
   `native-production-dependencies.ts:230`. The claim "every site" is what makes
   the byte-identical guarantee checkable; a partial list would undermine the
   check rather than the design. `terminalSequenceSurface` is replaced by
   `executesTerminalControl` at `executor.ts:141-143` and
   `local-turn-plugin-hooks.ts:96-110`. `contentReviewEnabled` becomes a local
   expression in `services.ts` in the same phase.
5. **Phase 4 — prompt validation.** Fix `prompt-renderer.ts:33` and add runtime
   validation for `promptProfile`. `service/agent/contracts.ts:19` declares
   `AgentPromptProfile = 'desktop' | 'tui'` with no runtime check, so an unknown
   value makes `usesV2Prompts` (`catalog.ts:609`) false and silently falls back
   to the legacy renderer. ***This changes prompt text for any caller passing
   `--prompt-mode coding|work`*** (`tui/src/headless/invocation.ts:100`). The
   default `promptMode: 'tui'` masks it today, which is why it looked latent.
6. **Phase 5 — add the decided `webui` row**, and verify it by standing up a
   host with `runtimeOwnerKind: 'webui'` in a test. **An `it.each` over policies
   is not sufficient**: a row nobody instantiates is the original bug inverted.
   This test is the exit condition for the whole change, and it is where the two
   deliberate WebUI behaviour changes become *observable* — WebUI stops being
   told it executes terminal control sequences, and its memory collector opens.
   Neither is live in production until the WebUI flip, because WebUI still
   declares `'tui'` at this point.
7. **Phase 6 — nothing further.** What happens next is WebUI-side and out of scope.

## Deferred, and what unblocks it

| Deferred item | Unblocked by |
| --- | --- |
| Flip `assembly.ts` to `runtimeOwnerKind: "webui"` | phase 5 |
| Drop `capabilityProfile: "cli"` — **only after phase 3.** It has four effects, two of them channel gates (`host.ts:455`, `host-channel-composition.ts:314-316`). Dropping it early silently enables channels. | phase 5 **and** `wiring.channelService` wired to both sites |
| ADR 0012 cron panel migration | phase 5 **and** the WebUI data migration plan |
| Add `runtime.ts` to the probe and add a third gate | a WebUI-package change |
| **Repoint the probe at the policy module** — done as a side effect of phase 3, not by choice. Phase 3 rewrote `services.ts` so `enableCron:` reads `options.ownerPolicy.wiring.cronService`, and reduced `ownsElectronRuntimeCapabilities` in the browser-use composition to a re-export. The probe reads both by string surgery, so gate 1 now resolves to **`unconfirmed`** and five of its tests fail. The probe is behaving correctly: it reports "this probe does not know where cron is gated now" instead of guessing. The WebUI package is out of scope for this change, so the failure is accepted rather than fixed. | a WebUI-package change, accepted deliberately |
| Reconcile `profile-files.ts` with the harness memory service | phase 5 **and** a decision on which writer owns the files |
| Verify on a live WebUI host that memory, cron and Computer Use appear | phase 5 **and** `config.beta.cuMode === true` |
| Correct the ADR 0004 misattribution in two WebUI comments | a WebUI-package change |
| The WebUI-level integration check that would justify "first-class client" | the declaration change |
| `mavisCronAdapterProvider` wiring | separate harness fix; see above |
| Decide the `'absent'` row's semantics | a named follow-up, deliberately not this change |

## Verification strategy

The test that matters is not a type test. It is: **assert that what a client
declares equals what the harness actually builds.**

- Phase 1: table-driven test over existing owner values, plus the guard test for
  `'test'`.
- Phase 2: `surfaces` assertions. Diagnostics-only, so the assertion is on
  document contents.
- Phase 3: `it.each` over policies against mocked `agentHostOptions`, proving
  byte-identical behaviour for `electron`, `cli`, `tui`, `runtime` and `absent`.
- Phase 5: a real host constructed with `runtimeOwnerKind: 'webui'`, asserting
  `ownsV2Runtime` held the compatibility layer and the granted services were
  built. **This proves the harness side only** — see the scope section.

A real host run takes 30-100 s and opens SQLite. It is not a unit test. Existing
identity assertions live in `local-runtime-v2/src/services.test.ts`, mostly
hand-written per behaviour against mocked `agentHostOptions`, with one
`it.each(["tui","electron"])` table around `:2385`.

## Known risks and unverified claims

- **The enforcement guarantee is harness-internal.** WebUI's local type and
  `as unknown as` cast mean no client is compile-time constrained.
- **The two groups hold only if consumers use them.** Flattening the policy, or
  rebuilding policy from `kind` at a call site, reduces the type to
  documentation.
- **The one non-byte-identical cell is `channelService`, and it diverges on SEVEN
  combinations, not one.** Merging the two channel switches into one cell, as phase 3
  requires, cannot reproduce both original answers where they disagreed. `host.ts`
  asked only `capabilityProfile !== 'cli'`; `services.ts` asked only the owner kind.
  The cell takes the stricter (kind-based) answer. The disagreeing inputs are:
  `undefined/'cli'`, `electron/'cli'`, `cli/undefined`, `tui/undefined`,
  `runtime/undefined`, `test/undefined`, `webui/undefined`.

  **An earlier draft of this section named a single case (an explicit `'runtime'` owner
  with no `capabilityProfile`) and called it "the one exception". That was wrong on
  both counts** — the count and the choice of example. `electron` with
  `capabilityProfile: 'cli'` is a real in-tree-shaped pairing and diverges too. The
  full enumeration is asserted in `runtime-owner-policy-identity.test.ts`, so the
  divergence is measured rather than described.

  Whether each combination is a supported input needs a stated contract; that is a
  follow-up, not something this refactor silently decides.
- **`titleSafetyBypass: true` is provisional**, carried as today's effective
  value. It is a provider/trust decision, and its current justification is
  compatibility rather than principle.
- **The `'absent'` row records a defect rather than fixing it.** An absent owner
  keeps memory, cron, channel and desktop browser activation, and loses the
  compatibility layer.
- **`restricted` cannot be decomposed today.** `disableMemory`, `disableCron`
  and `disableComputerUse` share one branch
  (`hosted-agent-capability-factory.ts:31-34`).
- **WebUI session agent names are not uniform.** Memory conclusions drawn from
  the composer do not generalise to the plugin chat flow or the scheduler.
- **`runtimeOwnerKind` is not persisted to any database.** It appears only in
  metrics and diagnostics, all openly typed
  (`local-runtime/src/runtime/host-metrics.ts:22`,
  `shared/src/local-runtime-logging/metrics.ts:37`,
  `shared/src/local-runtime-diagnostics/types.ts:8`). The persisted
  `sessionLocks.owner_kind` (`infra/db/schema/turn.ts:15`) is a different
  namespace (`turn` / `compaction` / `maintenance`); the client's owner kind
  reaches only the in-memory `lockOwner` (`host.ts:704-709`). Targeted grep
  only; an exhaustive database audit was not performed.
- **`remoteSkillHub` depends on `isManagedRuntime()`** (`host-factory.ts:325`),
  environment-dependent and not decidable from source.
- **All findings above are from reading source.** No runtime host was started and
  no behaviour was observed. ADR 0012's measurements were taken at `2f064db` on
  2026-10-05 and were not re-verified here.

## Post-hoc validation: was the policy warranted?

`memoryFeature: true` may have been reachable with one WebUI-side edit — set
`capabilityProfile` to `undefined` and let `features.mavis` flow. The experiment
needs a WebUI declaration, so it belongs to the deferred side. Run it after phase
5 as a check, not a precondition: on a real host run, diff the observed prompt
context (`features`, `skills`, `memory.enabled`, `cron.enabled`) and
`agentHostOptions` between the declared `'tui'`/`'cli'` pair and the `webui` row.

Two things hold regardless:

- The cheap path also hits the `disableMemory` gate, since `restricted` is true
  today under either declaration.
- Even the cheap path leaves `surfaces` lying about `cron` and `channelBridge`,
  which phase 2 fixes independently of any client.

## Decision log

| Date | Decision | By |
| --- | --- | --- |
| 2026-10-08 | WebUI does not contribute upstream; harness edits are local to this branch | maintainer |
| 2026-10-08 | `memoryFeature: true` for WebUI | maintainer |
| 2026-10-08 | `mavisFeatureBundle: true` for WebUI | maintainer |
| 2026-10-08 | `restricted: false` — memory, cron and Computer Use together | maintainer |
| 2026-10-08 | This change is harness-only; all WebUI-side migration deferred | maintainer |
| 2026-10-08 | Introduce a policy resolver rather than adding `'webui'` directly | reviewed |
| 2026-10-08 | Narrow to thirteen cells in two groups; drop the redundancy shortcut as a merge criterion | reviewed |
| 2026-10-08 | `'absent'` and `'runtime'` are distinct rows; no hidden normalisation | reviewed |
| 2026-10-08 | `titleSafetyBypass: true` carried provisionally | reviewed |
| 2026-10-08 | Keep the harness/WebUI split; narrow the exit claim to what the harness proves | reviewed, counter-review concurring |
| 2026-10-08 | `mavisCronAdapterProvider` gap filed separately from WebUI scope | reviewed |
| 2026-10-09 | Leave the WebUI upstream probe broken rather than edit `packages/webui`; the harness/WebUI split holds | maintainer |
| 2026-10-09 | Independent post-implementation review (gpt-6-luna): plan **not** complete — phase 3 gaps | reviewed |
| 2026-10-09 | `promptSurfaceDefault` threaded to both `resolveAgentPromptSurface` consumers; WebUI was silently `interactive` | reviewed |
| 2026-10-09 | Prompt-level memory/cron gates now read policy, so the unknown-owner guard is fail-closed there too | reviewed |
| 2026-10-09 | `host-channel-composition` migrated off `capabilityProfile` — it was a promised phase 3 site | reviewed |
| 2026-10-09 | `channelService` divergence is **seven** combinations, not one; the original single-case claim was withdrawn | reviewed |

Computer Use is recorded as a deployment constraint, not an open question:
ADR 0004's loopback-only binding is a precondition for it.