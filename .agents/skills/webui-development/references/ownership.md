# Ownership, submission and async lifecycle

Read `packages/webui/docs/client/ownership.md`, `submission.md` and, for input fields, `composer.md`. Source paths below are under `packages/webui/src/client/`.

## Application lifetime

Trace `main.tsx` → `application/create-application.ts` → owner. Construction is dormant. `start()` applies initial selection before unread hydration, activates initial reads and attaches one process-event ingress. Start is idempotent while started; disposed instances refuse restart. Application disposal fences its lifecycle first, attempts every cleanup and retains labeled failures. This does not prove that each leaf owner fences its own pending work: inspect the owner being changed.

One long-lived application `watchEvents` ingress uses `platform/event-channel.ts` through `bindings/event-channel-adapter.ts`. Send/resume delivery and terminal watches are separate; one ingress does not mean one socket for the product.

Owners are framework-free; snapshots stay stable until changed for `useSyncExternalStore`. Assembly owns the canonical session record and independent business owners. Do not duplicate mutable truth for a panel.

Most owners live for application/session lifetime. Preserve explicit exceptions: Models' `application/provider-editor.ts` is used once per Usage-page visit, above the custom-source conditional. Draft generation invalidates older test results; operation generation fences close/dispose. Local uncommitted forms and ephemeral presentation state may stay local.

## Resource identity

Use `conversation/request-freshness.ts` when cached reads have identity/freshness obligations.

| Mechanism | Contract | Consequence |
| --- | --- | --- |
| Keyed resource | Answer stored under all response-affecting inputs | Include session/agent/snapshot and opaque credential/configuration epochs when relevant; never secrets |
| Selected slot | Destination has identity and selection generation | A valid A result cannot populate selected B |
| Commit token | Resource, revision and owner incarnation must match | Recreated owners reject old completions |
| Invalidation | Advance freshness before repair scheduling | An older read cannot clear a later dirty revision |
| Coalescing | Match key, revision and incarnation | Pre-invalidation pending reads are not fresh repairs |
| Request outcome | `ready` with token/value, `superseded`, `disposed`, `failed` | Consume this request's outcome rather than guessing from shared state |
| Epoch/release | Retire affected identities and subscriptions | Preserve unrelated resources and monotonic stale-token fences |

Reuse `runWebuiMutation` where appropriate: submitted writes invalidate affected resources. Invalidation obligations outlive mounted views. Distinguish absent capabilities, stale/disposed results, empty data and successful mutation; keep original errors.

Read actual examples: Settings summary/body are separate keys; Models acquisition differs from catalogue selection; Review separates turn changesets/workspace snapshots; Workspace has files/environment/archive/canvas owners.

Existing implementations do not all use the same primitive. At this baseline `workspace-files-owner.ts` uses request versions keyed by operations/tab IDs and its `dispose()` only clears listeners; it does not itself invalidate pending reads. `workspace-queries.ts.releaseSession()` releases canvas state, not every file resource. Treat lifecycle rules as requirements to preserve or establish for touched behavior, not evidence that every leaf already satisfies them. A preview refresh must also account for the current `readFile()` cache short-circuit and `setInlineFile()`/`discardTab()` supersession; add a named owner command instead of a component fetch or generic state clear.

## Interests and execution

`conversation/session-scope.ts` tracks independent selected-view, secondary-consumer, delivery-attempt and command-settlement interests. Navigation releases its own interest. `turn/application/stream-lease-controller.ts` and `conversation/stream-lease.ts` fence attempts by generation; one live lease per session owns stream writes.

Keep `conversation/stream-loop.ts` generic. Turn's `stream-loop-sink.ts` adapter owns Turn/Transcript interpretation. Do not push business transitions into generic delivery to reduce wiring arguments.

Closing pages, releasing views and detaching delivery end observation. Explicit stop invokes `abortSession`; removing an unstarted queued item is another operation. Terminal owner disposal ends browser watches; `runtime/terminal.ts` owns processes for the service. Hiding xterm or detaching a secondary page must not kill another page's PTY.

Authoritative deletion revokes commit rights, releases owned detail and detaches late delivery handles. Compact deleted-ID fences survive until application teardown because events have no replay barrier; count them separately from live cache/interest/detail.

Read `packages/webui/docs/adr/observation-architecture.md` before proposing server snapshot/delta reconciliation; recheck host capabilities against that decision.

## Creation and input consumption

`application/task-session-workflows.ts` owns workspace/no-project policy, creation completion, home incarnation and navigation epoch across send/goals/plugins/rail creation. It delegates to existing stores rather than keeping another session map.

Read `turn/contracts/submission.ts`, `turn/application/submission-admission.ts`, `composer-submission.ts`, `execution-target.ts`, and `composer/application/composer-controller.ts` together.

- Tickets separate immediate admission, early creation identity/navigation and terminal completion. Adoption must not wait for stream settlement.
- No delivery capability refuses unsupported before creating. An in-flight home creation is busy. Live turns queue only with queue capability; queue support alone does not imply send support.
- Completion represents dispatch/queue/refusal/failure as values. Preserve exact current unions rather than reducing them to a success boolean.
- Creation is single-flight per captured home incarnation. Adopt/select under the initiating navigation claim. Existing destination state wins; purged targets stay deleted; superseded sources are stale.
- Home adoption transfers draft/history/goal read together; failed creation preserves input.
- Capture slot/session identity, draft revision and submitted staging before awaiting. Consume only captured input; newer edits and another selected session survive.

Cross-business flows receive published intents/commands: Interactions invokes Turn's `WebuiInteractionPhaseIntents`, while Turn keeps its writer and lifecycle.

## Regression selection

Choose affected scenarios: delayed A after selecting B; invalidation while reading; release/recreate same key; dispose during settlement; delete before attach; submit twice during creation; edit during submit; navigate before creation; switch away before DONE; secondary-page PTY detach; malformed persisted rows versus real render failure. Assert observable state/outcomes, not helper or testid existence.
