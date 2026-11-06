# Responsive session observation and execution lifecycle

**Status:** Accepted design; implementation and runtime/performance acceptance are pending.
**Date:** 2026-11-06.
**Source baseline:** `5ffb30dc2a3bb191142aeddf96fc7e57796aa39a`.
**Authority:** The user approved decisions Q1–Q18 and confirmed the complete synthesis in Q19.
D01–D18 below preserve those question numbers. This record is the implementation authority;
the tracker specification and tickets derive from it, not the other way around.

## Context

Users report that an SVG appears when an Agent reply completes, disappears shortly afterwards,
and returns after refresh; child sessions do not promptly appear in the rail; background tasks
do not appear in the workspace panel; queue Send now waits before visibly doing anything;
and streaming can stall input, page updates and animations. Repeated local repairs have not
established a reliable lifecycle contract. These reports motivate the design; they have not
yet been reproduced or measured in this initiative.

Static inspection finds several distinct boundaries, not a proven single renderer defect:

- Transcript completion reconciliation currently includes component refs/effects, history retries
  and a message-ID/text-length/asset-count catch-up heuristic.
- The session catalog, transcript and workspace progress use different update paths.
- The harness provides background-task records, but the WebUI host-contract derivation explicitly
  lists `listBackgroundTasks` as not forwarded.
- The harness session stream already names message commits, replacements, rewinds and terminal
  frames with session/turn identity and a cursor. Compatibility mapping reduces some of that
  information to ordinary messages; a shared history-snapshot watermark is not established.
- Existing streaming performance coverage measures frame gaps, long tasks and timer delay for
  synthetic text/code workloads. It does not establish media, settlement, concurrent-task or
  interaction performance. Existing memoization, block reuse and content visibility must be
  measured before proposing their replacement.

These observations are navigation evidence, not reproduction, benchmark results or a declaration
that every reported symptom shares a cause.

## Relationship to existing decisions

Retain ADR 0016's business owners and application lifetime, ADR 0017's temporal fences and
separation of delivery attachment from execution abort, and ADR 0018's implemented ownership
work. Amend only the forward constraint in ADR 0018/A5: its 2026-10-16 observation comparison
does not prohibit a measured revision using today's session-stream capabilities. Reuse existing
capabilities before extending contracts; do not presume a new durable event log or transport
is necessary. Client reconciliation remains necessary where the confirmed contract requires it,
but components must not own execution reconciliation.

ADR 0023 supplies complementary contract, built-browser and production-path evidence.
ADR 0028–0030 still govern shared controls, motion and feedback. A pending/failed submission
that remains actionable is a persistent state; one-time notifications use the shared toast.
This does not authorize ad hoc spinners, duplicate announcements or a visual redesign.

## Decisions

### D01 — Complete path, evidence-driven modification scope

Investigate and design the full harness-fact → WebUI runtime adapter → loopback → WebUI
application → transcript/rail/workspace-panel path. Change a layer when evidence requires it.
Do not limit the work to rendering components, or expand it into an unrelated harness rewrite.

### D02 — Three independent acceptance obligations

Correct behavior, maintainable responsibility boundaries and materially improved UI performance
are all required. No green gate, attractive diagram, reduced file length or performance result
substitutes for the other obligations. New content and lifecycle states must have identifiable
extension points, one responsible owner and testable transition rules.

### D03 — One design, complete vertical migrations

Migrate narrow complete behaviors, with executable evidence and removal of the replaced path
in each slice. Any temporary compatibility bridge has an owner and exit condition. Do not
leave competing live/history or task authorities as the final architecture. Preserve valid tests
and unrelated work. The final integration slice audits residual bridges rather than postponing
all cleanup until the end.

### D04 — Entire supported session lifecycle

Inventory every existing user-reachable session operation and its applicable states, including
submission, attachments/references, queueing, Send now, queue deletion, explicit stop, failure
retry, historical user-message editing, rewind, fork, permission prompts, questionnaires,
Plan mode, Goal, compaction, review/file results, session navigation/transfer/lifecycle,
history paging, refresh, reconnect and externally initiated changes.

For each operation × applicable state, specify allowed execution, queueing, waiting, refusal,
cancellation/replacement, observation-only behavior and the resulting state. Include meaningful
event-order permutations: delayed acknowledgements, duplicate facts, old terminal frames,
history responses crossing mutations, navigation/deletion during requests, and task completion
after parent termination. Explain inapplicable combinations; do not claim enumeration of
infinitely many schedules. New unrelated features are not implied by the inventory.

### D05 — Confirmed creation appears promptly

A child session or background task becomes visible when the harness confirms creation, without
waiting for the parent turn to finish, a panel to mount or a manual refresh. Incomplete metadata
may be filled in subsequently. Before confirmation, show starting intent without claiming an
existing running task. All relevant regions converge on the same identity and facts; identical
paint-frame timing is not required.

### D06 — Continuous content and distinct completion facts

Older history must not remove already observed content during normal settlement. Replace the
live representation only with sufficient authoritative evidence, not equal text length or
asset count. Intentional edit/rewind can remove or replace content; stale responses and old
execution frames cannot undo that newer accepted state.

Turn termination, submission settlement, durable content synchronization, media loading and
background-task completion are separate facts. A synchronization failure retains useful content
and a recoverable state instead of silently deleting it or leaving the Agent thinking forever.
Do not infer all-task completion or media durability from a turn-terminal event.

### D07 — Visual and behavioral continuity

Keep the existing visual language, main interaction patterns, historical-session readability and
supported content. Add necessary task, pending, stopping and recovery states. This is not a
general visual redesign. Preserve existing Desktop behavior when shared contracts change;
Desktop UI redesign is out of scope.

### D08 — Send now immediately presents intent

On activation, project the selected queue item into the transcript with stable identity and
an honest pending state; it is no longer displayed as an ordinary queued item. The previous
reply no longer owns the current reply position. Late output remains attributable to its old
execution and must not append beneath the new message.

Confirmation settles the same message in place, without duplication or flicker. Failure preserves
input and retry; unknown outcome requires reconciliation before retry. Preserve the harness's
queue claim/steer semantics, including continuation within a turn or activation of a new turn.
Do not implement a browser-side abort/delete/resubmit sequence or start conflicting concurrent
executions merely to give immediate visual feedback.

### D09 — Coordinate only real conflicts

Keep typing, reading and navigation responsive. Show newly submitted intent promptly while
respecting accepted message order. Duplicate activation has one effect. Serialize or explicitly
refuse operations that conflict on the same history or execution; do not blindly queue an edit
whose target may disappear. Stop has priority over ordinary queued submissions but remains
bound to the intended execution, never an accidentally newer turn.

### D10 — Rewind invalidates dependent work

Edit/rewind requests stopping of still-running child/background work created by the invalidated
execution range. Leave unrelated sessions and work outside that range alone. Late results must
not re-enter or wake invalidated execution. Preserve unexecuted queue items and pause automatic
consumption so the user can choose to continue or delete them in the new context.

Stopping, stopped, failed and unknown are distinct. Stopping cannot undo already produced
external effects. File restoration remains an explicit independent choice, never an implicit
expansion of message rewind.

### D11 — Receive facts independently of paint frequency

Prioritize meaningful user feedback and permission, creation, failure and terminal state changes.
Coalesce high-frequency text/log presentation without losing content, reordering facts or
allowing an unbounded display backlog. Nonselected sessions and hidden panels retain recoverable
state without doing all visible Markdown/layout/animation work. Keep streaming and normal motion;
do not optimize by waiting for a whole answer or removing animations by default.

### D12 — Observable, controllable execution tasks

The rail navigates sessions; the workspace panel shows associated execution tasks with identity,
kind, ownership, state, useful summary, details/output and individual stop. A subagent task and
its child session are related identities, not two unrelated executions. Completed tasks remain
inspectable; large output is loaded on demand. Scheduled tasks and user-opened terminals keep
their existing distinct entries and are not conflated with Agent background execution.

### D13 — Application-owned coordination with narrow subscriptions

The harness owns execution and durable facts. The WebUI application owns command lifecycles,
pending intent, history/live handoff, queue coordination, task associations and stale-result
rejection. Components submit intents and read projections rather than repairing execution state
with effects. Rendering owns Markdown/media, layout, scrolling, motion and presentation scheduling.

Use the existing session-record repository and narrow business owners, resource identity,
generation/freshness/commit fences and public contracts. One authority does not mean one
monolithic store or a global render notification. Subscribe by session/object/slice so unrelated
updates do not reprocess the page. Preserve the single application event ingress and transport
ownership; no parallel event bus is mandated.

### D14 — Recover pending intent without accidental execution

In the same browser, retain the minimum operation identity and user input needed to recover an
unconfirmed operation. After reload/reconnect, reconcile its harness outcome before deciding
accepted, failed or still unknown. Never resend an ambiguous write automatically. An intent
known not to have been sent returns as user-actionable input, not an automatic post-refresh
execution. Clean completed temporary records; authoritative persisted messages and queue records
remain authoritative. Do not duplicate another browser document's pending command or store
credentials in this recovery record.

### D15 — Bounded rich-formatting deferral

Where measurements justify it, an unfinished expensive code block may show readable code before
highlighting catches up, and an incomplete complex diagram may show a generating state. Complete
blocks receive their final formatting without waiting for the whole turn. Delays are bounded
and measured. Keep stable identity for displayed PNG/SVG/video so unrelated updates do not
reload media or reset playback. Preserve scrolling, text selection, copying, search and history
positioning; a windowing strategy cannot silently trade those behaviors away.

### D16 — Immediate feedback, safe execution barriers

Edit/rewind immediately displays intent and progress, but conflicting invalidated work must be
confirmed stopped before dependent file restoration or new execution proceeds. Stop failure or
uncertainty blocks only the dependent steps, with actionable status and retained input. Report
partial outcomes explicitly, including history rewind succeeding while edited resubmission fails.
Recovery resumes the failed stage without duplicating completed effects. Independent navigation,
typing and inspection remain available.

### D17 — Multiple observers and command sources

Converge messages, queue, tasks and history when another WebUI document or compatible client
changes the session. The harness adjudicates conflicts; reject or reconcile obsolete commands
rather than silently overwriting a newer revision. A document owns only its pending intents;
attachment/reload is not an instruction to repeat execution. Cover multiple WebUI tabs and
external-client changes while preserving existing Desktop contracts.

### D18 — Measured performance budgets

Pin machine, browser/version, display/viewport, build mode/revision, input workload and measurement
method before comparison. For ordinary workloads, operation → first meaningful visible feedback
must have P95 ≤ 100 ms. Harness execution latency is reported separately, not included in this UI
budget. Define each operation's meaningful state before measuring; a decorative spinner alone
does not establish the Send now outcome.

For a reproduced stuttering heavy workload, target at least 50% improvement in the primary
stutter metric selected and recorded before optimization. If the baseline is already zero or
below measurement resolution, preserve an absolute budget instead of claiming an undefined
percentage. Any necessary change to an approved target requires evidence and user agreement.

Record frame-gap distributions, long-task counts/durations, total blocking time, event-receipt →
visible-content latency and post-terminal stabilization. Prevent batching from improving frame
metrics by delaying content indefinitely. Include long history, rich media, settlement, concurrent
tasks and input/scroll/Send now/stop under streaming; check retained memory, subscriptions and
work after navigation and completion. Preserve already smooth ordinary workloads. The existing
50 ms frame-gap check is not a 60 fps guarantee.

## Verification contract

Use the highest existing practical seam: actual browser controls in the built client, through
the real loopback/service/runtime adapter and production harness/session store, to visible and
persisted outcomes. A deterministic local model leaf may control content and timing, but cannot
replace the application boundaries being claimed. Use isolated synthetic workspaces, media and
stores; report external-provider, operating-system and browser boundaries separately.

Complement that main seam with deterministic controlled-delivery browser scenarios for event-order
faults and focused contract/state-transition tests where necessary. Existing transcript-file-media,
workspace-progress-live, transcript-scroll and streaming-performance browser coverage, application
command tests and loopback-harness integration are prior art, not proof of current acceptance.
Fixtures must match a real producer; a fabricated spawn event cannot prove runtime integration.

Before implementation, establish a red-capable reproduction or explicitly disclose what could
not be reproduced, audit current coverage and record a performance baseline. Verify sustained
correct state after settlement, not just one transient render. Negative controls on critical
crossings must demonstrate that the acceptance assertion detects a broken link.

Each implementation ticket owns its observable assertions and relevant narrow gates. Build before
browser tests; register new Vitest files; review inventory additions; keep reports outside the
repository. Do not run aggregate gates by default. Runtime/stream/performance implementation PRs
follow the repository's `perf:full` classification. This documentation change claims no product,
runtime or performance verification.

## Delivery targets and unique carriers

The counting unit is a delivery target, not an operation, file, test or decision. There are exactly
18 targets, T01–T18, one row and one producing ticket per target. D identifiers are reusable
constraints; their appearance in several tickets does not create duplicate delivery ownership.
Dependencies below are direct implementation blockers, not an artificial total order.

| Target | Producing ticket and complete outcome | Blocked by | Decision sections |
| --- | --- | --- | --- |
| T01 | Reproduction, supported-operation/state matrix and locked performance baseline | None | D02, D04, D18 |
| T02 | One text reply remains authoritative through live/history settlement | T01 | D01, D06, D13 |
| T03 | PNG/SVG/video remain continuous through updates, settlement and reload | T02 | D06, D07, D15 |
| T04 | Ordinary submission, first-session adoption, retry and queue CRUD respond immediately | T02 | D04, D09, D13 |
| T05 | Send now presents intent immediately and performs one reliable queue handoff | T04 | D08, D09 |
| T06 | Pending submissions recover after reload without loss or duplicate execution | T05 | D14 |
| T07 | Associated execution tasks appear with lifecycle, details and demand-loaded output | T02 | D05, D12 |
| T08 | Child-session rail navigation and task views share confirmed identity and state | T07 | D05, D12 |
| T09 | Session stop and individual task stop report actual execution outcomes | T05, T07 | D09, D12, D16 |
| T10 | Rewind safely invalidates dependent work, pauses queue and honors explicit file restore | T09 | D10, D16 |
| T11 | Historical user edit performs safe rewind and recoverable resubmission | T06, T10 | D04, D14, D16 |
| T12 | Permission/questionnaire/Plan interactions remain timely and settle once | T02 | D04, D09, D11 |
| T13 | Goal, compaction and command admission preserve lifecycle semantics | T04, T09, T12 | D04, D06, D09 |
| T14 | Concurrent clients, reconnect/resync and obsolete mutations converge | T06, T08, T11, T12, T13 | D06, D14, D17 |
| T15 | Navigation, fork, session lifecycle/transfer and history paging preserve state | T08, T11, T13 | D04, D07, D13 |
| T16 | Streaming and concurrent task updates meet responsive scheduling budgets | T03, T05, T07, T12 | D11, D13, D18 |
| T17 | Long-history/rich-content workloads retain reading behavior with bounded rendering cost | T15, T16 | D07, D15, D18 |
| T18 | Combined workflows meet all obligations and residual obsolete paths are retired | T14, T17 | D02, D03, D04, D18 |

T01 records the full supported-operation/state inventory and assigns each implementation row to
one carrier in T02–T17. It does not implement those carriers. T18 audits combined coverage and
residual compatibility paths; it does not re-own their features. T01 may expose additional
existing entry points: assign them to the fitting carrier and update authority/spec/board
together; ask the user only if this changes approved behavior or scope.

T02 establishes the minimal end-to-end text path and explicit confirmation semantics, not an
up-front horizontal rewrite. Subsequent slices expand that working path. T16 establishes measured
scheduling improvements; T17 owns further long-history/rich-content improvements against the same
baseline. Their performance populations are recorded separately to avoid double attribution.

## Operation-family coverage

This is the starting source-derived inventory, not a claim that every applicable permutation
already has a test. T01 verifies entry points and completes the executable matrix. Each row's
primary carrier produces its behavior; T14/T18 exercise cross-client/combined combinations.

| Operation family | Primary carrier |
| --- | --- |
| Ordinary submission, attachments/references, first-session creation/adoption, failed-input retry | T04 |
| Queue read/enqueue/delete and ordinary automatic consumption | T04 |
| Queue Send now and duplicate/overlapping activation | T05 |
| Pending-command reload/unknown-outcome recovery | T06 |
| Task lifecycle/details/output; parent completed while task continues | T07 |
| Child-session creation/navigation/status | T08 |
| Explicit session stop and individual task stop | T09 |
| Rewind preview/commit, related-task barrier, queue pause, explicit file restore and review revert/reapply | T10 |
| Historical committed user-message edit and resubmission | T11 |
| Permission allow/deny, questionnaire answer/dismiss and Plan review | T12 |
| Goal create/edit/pause/resume/clear, compaction and existing command admission | T13 |
| Reconnect, cursor replay/overflow resync and external/multi-document changes | T14 |
| Session selection/return, fork, rename, archive/unarchive, delete, import/export and history paging | T15 |

Existing browser queue editing/reordering, arbitrary-text steer and standalone assistant
regeneration were not established by the source inventory. They are not silently added as new
features. If an actual existing caller is found, T01 includes it in the matrix. Background-task
display/details/stop are expressly approved new capabilities.

## Alternatives and consequences

Component-local patches cannot establish cross-region authority or execution barriers.
A wholesale rewrite before an observable slice would postpone the first proof of the design.
A single globally notifying store would concentrate responsibility while retaining unnecessary
render work. Hiding animations, removing rich content or waiting for a whole answer would improve
a measurement by changing the approved experience. These approaches are rejected.

The accepted design adds explicit pending/recovery and partial-result handling, may require
additive wire/harness capabilities, and makes safe rewind depend on task outcome evidence.
Those costs buy visible responsiveness without inventing successful execution. Exact payloads,
batch intervals, data structures and any windowing choice follow source verification and
measurement; they are not preselected by this ADR.

This initiative does not authorize publication to upstream, production-data mutation, external
messages, paid-provider tests, an unrelated engine rewrite or execution of the implementation
tickets merely because their specifications are published. The current deliverable is the ADR,
tracker specification and dependency-linked tickets.
