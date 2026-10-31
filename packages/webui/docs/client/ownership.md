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

**Delivery detach is not execution abort.** Hiding or closing a view, or closing the browser
connection, ends that client's observation — it does not stop the harness's turn. Only an explicit
stop calls `abortSession`, and only an unstarted queued item is removable from the queue.

## Reconciling delivery state

The client reconciles its own turn/stream state, and this is a decision, not an omission: a server
snapshot-plus-deltas design was prototyped and measured against the client's policy, and it reached
consistency only by inventing capabilities the host does not have. Read
[`../adr/observation-architecture.md`](../adr/observation-architecture.md) before
proposing to move this state to the server.

## Surface facts worth knowing

- **Terminal.** The terminal process manager is owned by the WebUI *service*, not by a browser
  surface (`runtime/terminal.ts`; one instance per service, ended in `service.close()`). Hiding a
  tab or closing the page releases delivery and the xterm attachment; the process survives until
  explicit disposal.
  The panel renders the owner's availability verdict: known absence and unreadiness disable
  creation with different explanations; an older handshake with no roster keeps the unverified
  attempt path. Permission denial remains a call failure. The panel subscribes to catalogue changes
  while retaining xterm presentation by terminal identity, so output updates do not recreate a watch.
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
