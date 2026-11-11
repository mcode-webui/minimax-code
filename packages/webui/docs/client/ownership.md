# Client ownership and lifetimes

The browser side of `packages/webui`: one assembly, one event ingress, one writable session record,
and one directory per business. This document states the rules a change has to respect. The
directory map is in `../architecture/module-map.md`; the decisions behind these rules are ADR 0016
(business-first modules, application-owned lifetimes) and ADR 0017 (temporal ownership).

## Businesses own resources; roles own kinds of code

A business is one cohesive area of WebUI behaviour with its own resource identity, policies and
published commands or read models. It may serve several presentation surfaces without belonging to
any one of them, and owning a surface is not part of the definition: `terminal` owns the catalogue of
terminals this client knows about, the commands that create, write to, resize and dispose one, and the
watch registry that the workspace surface renders; `review` owns the turn-changeset and
working-tree-snapshot families that the transcript, workspace and settings surfaces read; `browser`
owns the per-target browser state — a page, its title and URL, and the run's selection — while
`workspace` owns the session's tab strip that renders it. The process behind a terminal belongs to
the service, not to the business — see *Surface facts worth knowing* below. `turn` is a business even
without a screen, because its attach-to-settle lifecycle and generation-fenced identity outlive any
surface. Both cells exist: the run's selection is the runtime's
(`runtime/browser/browser-service.ts`), and the client reads it rather than writing it — the toolbar
reports the runtime's mark and offers no way to change it.

Each business directory holds up to five roles, and the role decides what the file may do — not the
directory it happens to sit in:

| Role | Owns | Must not |
| --- | --- | --- |
| `contracts/` | The business's published surface: its capability port slice, view models, commands | Import implementation |
| `application/` | Workflows, state owners, query coordination | Touch browser globals, DOM, storage or concrete transport |
| `projection/` | Pure derivations from wire payloads and owned state to render shapes | Import React or perform IO |
| `bindings/` | React subscriptions, context, browser navigation and DOM effects | Acquire write authority or construct owners |
| `ui/` | Presentation | Call IO ports, instantiate owners, or reach a generic store writer |

The dependency rules and the role checks that enforce them are in `../architecture/boundaries.md`.

Mini App readers declare catalogue or presentation interest to `miniapp-workflows.ts`.
The owner uses one catalogue result per observation across listing readers and waiting views;
launcher interest requests periodic
freshness, while catalogue-only interest refreshes on acquisition and browser return. The provider
binds visibility/focus facts once. Presentation interest waits for detached leases, reconciles open
views, and ends automatic work on a stopped/refused state. Reader release fences automatic work;
application disposal fences all pending work, including a reconnect's first confirmation read before
any grace timer is created. Explicit user commands survive reader release.
`reconcileOpenPresentation` is the single open-state stop verdict, used by both interested-reader
observation and explicit `syncPresentations` reconciliation. User open/stop commands have per-plugin
operation revisions.

`client/application/miniapp-presenter.ts` coordinates host presenter epochs, revisions, selection
and asynchronous opening. The composition root constructs it; the shell binds navigation, history
and workspace commands. A newer intent or released binding prevents an older task from showing a tab.
The channel owner likewise owns pending authorization polling and shares it among open-pane readers;
selection, replacement QR, last-reader release and disposal fence delayed automatic authorization
results. Selection-based authorization starts only while its original pane observation interest is
current. Remount reacquires only an unbound WeChat authorization that is absent; it preserves the
selected bot's configuration/filter and performs no selection reload. Same-selection explicit reloads
retain those fields until their answers arrive. Explicit QR refresh and add-bot commands survive
observation release, while selection changes, newer commands and disposal still fence their results.
Selection detail reads have their own freshness revision: authorization reacquisition or refresh
cannot discard a pending config/filter answer for the same selection. A newer detail reload or
selection still supersedes it, and disposal prevents publication.

## Lifetime: one application, explicitly started

- The composition root (`client/application/create-application.ts`) constructs **dormant** owners,
  then start installs permanent routes, hydrates persisted state and starts ingress. It is the only
  place that knows which capability is wired.
- `dispose()` is idempotent and a disposed instance cannot restart; a fresh lifecycle gets fresh
  identity epochs. Dormant construction and explicit start/dispose are what make these lifetimes
  testable without React.
- There is exactly **one process-event ingress** per application instance: the single long-lived
  `watchEvents` subscription owned by the application (`client/platform/event-channel.ts`), shared by
  every consumer. A stream frame channel (`send`/`resume`) and the terminal's channel are separate.
- Session-scoped work survives the surface that started it. Selecting another session releases only
  the selected view's interest — not outstanding work.

## Temporal ownership

Workspace files, archives, canvases and environments use the terminal snapshot-store lifetime:
disposal freezes publication, releases subscriptions/timers and refuses new IO. Canvas reads,
writes and release share a destination revision; accepted writes still settle even when their
document can no longer be shown. The canvas component separately fences draft/preview callbacks
by its mounted session and operation lifetime; a settled write alone cannot clear current input.
Archive extraction publishes only for its originating listing
and extraction revision. Channel filter writes use the selected bot's detail revision.

Account login uses attempt and status-read revisions across begin, poll, cancel and dialog close.
Credential removal is shared by switch and sign-out: retire the credential epoch and reconcile
account/usage before beginning another login. Malformed check-in and directory responses enter
recoverable error states. Repeated hover/focus on an open usage panel does not start another quota
read; explicit refresh and retry still do. The rail displays the owner's last quota result while
a new read is loading, then adopts the new answer instead of hiding the subscription name.
Settings subscribes once per resource slot, independently of repeated
reads; retained model answers retire with their epoch/session resource. Composer catalogue
invalidation also retires outstanding promises, preventing stale successful consumption.

Scheduling acquires complete task and run snapshots through the shared cursor walker; plugin
marketplace and manageable skills use the same continuation/progress rule and stop acquiring
when selection changes. Missing or cyclic continuation is an error, never a complete partial
snapshot. Session catalogue reads have query revisions and are retired by authoritative patches;
flat and tree still resolve from one entity map. An invalidated pending flat/tree/page query
serially acquires an authoritative replacement before settling; all intervening facts, including
unknown non-created facts, share that one reconciliation. Newer explicit queries and disposal
retire replacement rights, so fact bursts cannot fan out concurrent automatic refreshes.
Explicit query-error clearing writes the cleared
value without requiring a reload. Schedule drafts retain unexposed timezone/run-cap fields and
map blank model/project values to the wire's explicit null-clear intent.

Four rules, each with a mechanism in `client/conversation/`:

- **Interest leases.** A session or resource is held by selected-view, secondary-consumer,
  delivery-attempt and command-settlement claims, each released independently. Navigation releases
  only its own claim. Accepted delivery and accepted mutation/invalidation obligations keep their
  rights until completion, supersession, explicit detach or recorded failure; purge and disposal
  revoke browser commit rights.
- **Generation fences.** Exactly one stream lease is live per session, carrying a generation one
  higher than the last. Every write a stream attempt makes is fenced against the generation it
  claimed, so a superseded attempt cannot write. `client/conversation/stream-lease.ts` and
  `stream-loop.ts`.
- **Incarnation and freshness.** A result may commit only to its own live owner incarnation, and an
  invalidation is repaired only by a result that covers its freshness revision — an earlier read
  cannot clear a later dirty revision. `client/application/identity-epochs.ts`,
  `client/conversation/request-freshness.ts`.
- **Keyed resources vs selected slots.** Resource queries are stored under a key covering every
  response-affecting input (including opaque credential/configuration generations), so two answer
  fields cannot overwrite each other. A selected destination is a separate cell with its own
  identity and generation, so a slow answer for an earlier selection is refused at the new one.
  A web tab's page is the browser's instance of that split: the page's title, URL and generation
  are answers keyed by the target, while the tab the person is looking at is the viewed cell
  (`WebuiBrowserPanelState.viewedPage`), so two tabs cannot overwrite each other's page state and a
  frame for a tab the strip has left is refused rather than drawn as the tab on screen. The frame
  stream is keyed by the target (`runtime/browser/browser-service.ts` — `watchFrames`), and the panel
  opens it for the viewed page.

Resource release retires cached detail, revisions, in-flight records and epoch subscriptions.
A monotonic revision floor prevents a released and recreated key from accepting old tokens.
Models releases obsolete epoch keys and projects an idle selected catalogue until its new identity
is read; provider and preset keys that do not compose the moved epoch remain current. Current-epoch
known-session caches stay with their owner until explicit session release, epoch retirement or
application disposal. Authoritative deletion releases Transcript/Models/Review/Workspace detail,
Goal/Interactions owners and deliveries. Compact deleted-ID fences remain until application teardown
because the event stream provides no replay barrier; they are measured separately from live detail
and interest counts. A late delivery handle for a deleted session is detached immediately.

Manual retry uses the same delivery hold as ordinary send/resume. The application can close that
observer during teardown even while its delivery promise remains pending; closing it never aborts
the host turn. Rail observation uses unfiltered known session identities, including tree children,
so search/disclosure changes do not manufacture fresh probes. Foreground inspection resumes once;
the event channel's activity repair does not restart it.
When the inspected session has no delivery lease, its foreground freshness read also retries
active-turn recovery. A failed cold-start probe therefore does not require a process-channel
reconnect or another navigation to discover a running turn. An existing delivery keeps its lease.

**Delivery detach is not execution abort.** Hiding or closing a view, or closing the browser
connection, ends that client's observation — it does not stop the harness's turn. Only an explicit
stop calls `abortSession`, and only an unstarted queued item is removable from the queue.

## Reconciling delivery state

The application reconciles turn delivery and transcript content separately:

| Fact | Owner | Consumers |
| --- | --- | --- |
| Submission admission and execution activity | Turn commands and runtime lifecycle events | Composer send/queue/stop controls |
| Immediate queue-send intent and outcome | `features/composer/application/queue-send-workflow.ts` | Transcript pending input and composer queue controls |
| Delivery attachment and stale-frame rejection | Turn's stream sink and generation lease | The session stream projection |
| Observed content awaiting persistence | `features/transcript/application/transcript-settlement.ts` | The transcript's retained-message slice |
| History pages, request freshness and pagination | `conversation/transcript-history.ts` | Transcript, context inspection and settlement |
| Final message groups and activity placement | `features/transcript/projection/transcript-view-model.ts` | `SessionTranscript` and `MessageItem` |

The settlement owner starts with the application, survives view navigation and ends before
delivery teardown. It preserves observed content across completed turns while keyed history reads
catch up. History evidence must cover the actual ordered text and asset identities; matching text
length or file count is insufficient. Fast retries back off to slow reconciliation with an explicit
recoverable synchronization state. Retrying synchronization never sends another Agent message.
Background synchronization does not select that session. Accepted edit/rewind invalidates retained
content and the previous stream generation; authoritative overflow replacement is distinct from an
ordinary history seed. History seeds must not overwrite richer observed content.
Committed `message.rewind` context-reset events enter this same replacement path, so a mutation
from another client invalidates the observed content and rereads that session without selecting it.

An immediate queue send presents its captured input before awaiting admission. Pending, accepted,
failed and unknown are distinct; admission alone does not mean the runtime has produced the user
message or begun another model call. The workflow preserves the host's atomic steering semantics.
Only the exact `source_message_id` / `sourceMessageId` queue identity in a live or durable user
message confirms its appearance. Equal text is not identity. Confirmation retains the pending
bubble's render key and removes its local status. Definitive refusal offers retry; an unknown
outcome retains input and offers a history recheck without automatically resending it.
An accepted context rewind changes unconfirmed pending/admitted input to an unknown outcome;
a late admission acknowledgement cannot restore the promise that it is waiting for processing.
The browser retains the input and offers a read-only history recheck. It does not manufacture a
paused runtime queue or automatically resubmit input. The current runtime does not return a
paused queue after another client rewinds a turn whose admitted steering input has not reached
the next model request (the runtime can already have emitted its canonical user message);
restoring that input to a paused queue is a recorded runtime gap outside this WebUI-only repair.
Local intent records survive session navigation. A full page reload discards unconfirmed local
input; preserving or recovering that input is intentionally outside the supported behavior.
Edit/rewind controls remain available only after generation has ended.
Cached historical action flags are masked while a turn is live. An already-open editor retains
its draft but cannot submit; an open rewind preview cannot confirm and can still be canceled.
Application mutation commands enforce the same restriction before issuing a runtime write.

Session selection starts active-turn recovery directly, independently of view effects and process
event-channel readiness. A recovery read that names a different active turn replaces only the
captured recovered lease; a newer lease or an outstanding local send remains protected.
Ordinary unary requests reuse the wire's existing idle-bounded connection, with separate request
identities and deadlines and no automatic replay. Stream subscriptions remain independent. This
prevents parallel bootstrap handshakes from delaying the history anchor and reply subscription.

Runtime terminal facts use the same turn-identity predicate for rail activity and transcript
execution. Stop acknowledgements are fenced by the generation captured at invocation, so a late
acknowledgement cannot settle a newer turn. Execution activity, delivery completion and persistence
confirmation remain separate facts.

The selected session's metadata is read from the catalogue entity map, independently of the flat
and tree pages' membership. Selection acquires missing metadata through the existing `getSession`
operation; concurrent same-identity reads coalesce, and navigation does not redirect their result.
Deleted sessions and disposed owners reject late metadata. This keeps workspace media and agent
identity available for deep links, paginated-out sessions and a missed external-creation event.

React session readers subscribe to immutable session/slice selections. Unrelated session, catalogue
or selection changes do not notify a stream-only reader. The transcript projection merges content,
groups it and returns final render views; components do not reconstruct assistant groups or schedule
settlement reads. Unchanged message/group views retain object identity, allowing constant-time
identity checks at `MessageItem` instead of recursive comparisons of reply bodies.

The 2026-10-16 comparison in
[`../adr/observation-architecture.md`](../adr/observation-architecture.md) rejected a
snapshot-plus-deltas prototype that depended on capabilities absent from the host/wire tested then.
[ADR 0032](../adr/0032-responsive-session-observation-and-execution-lifecycle.md) accepts a broader
lifecycle design whose remaining targets require their own implementation and acceptance. Its application-owned
coordination preserves these ownership and temporal fences; the historical comparison does not
establish today's capability inventory.

## Surface facts worth knowing

- **Terminal.** The terminal process manager is owned by the WebUI *service*, not by a browser
  surface (`runtime/terminal.ts`; one instance per service, ended in `service.close()`). Hiding a
  tab or closing the page releases delivery and the xterm attachment; the process survives until
  explicit disposal.
  The panel renders the owner's availability verdict: known absence and unreadiness disable
  creation with different explanations; an older handshake with no roster keeps the unverified
  attempt path. Permission denial remains a call failure. The panel subscribes to catalogue changes
  while retaining xterm presentation by terminal identity, so output updates do not recreate a watch.
  The owner also observes the settings owner's handshake snapshot and notifies mounted readers
  when terminal availability changes after reconnect; its disposal releases that subscription.
- **Team mode.** `createSession` carries `teamModeOff` as the only create-time team field
  (`shared/contracts/session.ts`). A session's team state is never read back from the server — there
  is no `teamMode` on the session view.
- **Settings.** The tabs and their enabled/disabled state come from one derivation
  (`client/features/settings/projection/settings-view.ts`); `voice`, `shortcuts` and `connection` are
  declared but disabled. The data directory is displayed read-only — relocation is not implemented
  (see `../known-gaps.md`).
- **Models.** Provider editing is owned by the Models business
  (`client/features/models/application/provider-editor.ts`), which holds candidate/test/save/discovery
  identity and its own pending/error semantics; the Usage settings page hosts one editor instance per
  visit above its custom-source branch. Model rows, search, hover, cascade and the draft editor are
  pure projections in `client/features/models/projection/`.
- **Review.** Turn changesets and working-tree snapshots are two distinct resource families with
  separate owners (`client/features/review/application/turn-review-owner.ts`,
  `workspace-review-owner.ts`); a revert or reapply invalidates the family it touched.
- **Browser.** The strip is per session: `client/shell/use-workspace-panel-session.ts` reads and
  writes panel state through `stateFor(sessionId)` and `dispatch(sessionId, …)`, so a tab opened in
  one session is not in another's. A tab is a stable slot whose content can be replaced in place, and
  the URL box exists only inside the new tab page — a web tab carries a toolbar (back, forward,
  reload, home to its launcher, and the URL read-only) instead. Back and forward are disabled when
  their corresponding history entry is absent. The run's selection and the tab the person is looking at are two
  cells with one writer each, with one bootstrap: a person who opens a web tab while the run has no
  selection gives the run that page, decided by the runtime at the moment the page appears
  (`WebuiBrowserTabOpener` — `runtime/browser/browser-service.ts` — `openWebTab`). A tab is a stable
  id and its content is what changes
  (`client/features/workspace/projection/workspace-panel-state.ts`), and the strip holds tool tabs and
  web tabs in one row. The browser tab is the isolated browser's view and the surface switcher it
  carries goes with it — the external browsers are driven in the user's own windows, so the panel is
  not where a surface is chosen.
