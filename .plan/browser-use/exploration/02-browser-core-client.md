# Implementation context: browser-core contracts & WebUI client conventions

Scope: implementation-context notes for "WebUI Browser Use". Read-only survey; nothing was
implemented or modified. Every claim below carries a `file:line`. Items I could not confirm from
source are marked **not verified — needs check**.

---

## 0. Plan claims vs. the current code

| Plan claim (`.plan/browser-use/browser-use-development-plan.md` §3) | Verdict |
| --- | --- |
| `packages/browser-core` owns provider-neutral browser actions and transport contracts | **Confirmed** — `packages/browser-core/src/browser-transport.ts:58`, `browser-core.ts:124` |
| WebUI must not import `packages/tui`; terminal-client implementations are references only | **Confirmed as a documented rule** — `packages/webui/docs/architecture/boundaries.md` ("Never import `packages/tui` (ADR 0003)"). See §5.4 for the caveat that it is not enforced by a literal denylist. |
| `packages/webui/src/runtime/browser-provider.ts` defines a host-supplied provider adoption seam | **Confirmed** — `runtime/browser-provider.ts:47` `adoptWebuiBrowserProvider` |
| `WorkspaceHtmlPreview.tsx` previews local HTML in an iframe and must not be repurposed | **Confirmed** — `features/workspace/ui/WorkspaceHtmlPreview.tsx:1-30` |
| browser-core is importable by WebUI | **Not true today** — see §5.3. `packages/browser-core` is in `release/extraction.json` `packageRoots`, but `packages/webui/package.json` does **not** declare it and `browser-core` has a single `"."` export that resolves types from `./src/index.ts` but runtime code to `./dist/index.js`. |

---

## 1. What a provider must implement to serve browser-core

### 1.1 The one transport contract

`BrowserTransport` (`packages/browser-core/src/browser-transport.ts:58`) extends
`BrowserPageLifecycle` (`:36`). A provider supplies **one object per page**.

Required members (verbatim signatures):

```ts
// browser-transport.ts:36-49
export interface BrowserPageLifecycle {
  readonly sessionId: string;
  start(signal?: AbortSignal): Promise<void>;
  /**
   * Reset the provider connection/session without closing the page.
   * ... Providers that do not need a reconnect may implement it as a no-op. `close()` is
   * reserved for permanently destroying the page and its provider resources.
   */
  resetConnection?(): Promise<void>;
  stopLoading(): Promise<void>;
  close(): Promise<void>;
}

// browser-transport.ts:58-100 (abridged to the members that matter)
export interface BrowserTransport extends BrowserPageLifecycle {
  readonly downloadDirectory?: string;
  openTab?(url: string): Promise<BrowserTransport>;
  send<T = unknown>(
    method: string,
    params?: BrowserTransportCommandParams,
    sessionId?: string,
    options?: BrowserTransportCommandOptions,
  ): Promise<T>;
  evaluate<T = unknown>(expression: string, options?: BrowserEvaluateOptions): Promise<T>;
  evaluateInAllFrames?<T = unknown>(expression: string, options?: BrowserEvaluateOptions): Promise<readonly T[]>;
  listAttachedFrames?(): readonly BrowserAttachedFrame[];
  onEvent(listener: BrowserTransportEventListener): () => void;
  waitForEvent(method: string, timeoutMs?: number,
    options?: Pick<BrowserTransportCommandOptions, 'signal'>): Promise<unknown>;
}
```

Optional: `resetConnection` (`:46`), `openTab` (`:65`), `evaluateInAllFrames` (`:88`),
`listAttachedFrames` (`:93`), `downloadDirectory` (`:60`).
Mandatory: `sessionId`, `start`, `stopLoading`, `close`, `send`, `evaluate`, `onEvent`, `waitForEvent`.

`CdpTransport` (`:103`) is a backward-compatible alias of `BrowserTransport`.

### 1.2 Narrower view for helpers

`BrowserPageTransport` (`browser-page-transport.ts:17`) is a `Pick<BrowserTransport, …>` over
`send | evaluate | evaluateInAllFrames | listAttachedFrames | onEvent | stopLoading | close`. Its
header comment states it exists "to prevent a second transport contract from drifting while
preserving the narrow dependency used by Electron". **A new provider must implement
`BrowserTransport`, not `BrowserPageTransport`.**

### 1.3 Addressing a page / target

- **Page** = one `BrowserTransport` instance. Identity is `sessionId` (`browser-transport.ts:37`).
- **Child targets / OOPIFs** are addressed by an explicit `sessionId` argument on `send(...)`
  (`:77`) and by `BrowserAttachedFrame` (`:26-34`), which carries `sessionId`, `frameId`,
  optional `parentSessionId`, `url`.
- `BrowserCoreSession` tracks the child session in `state.commandSessionId`
  (`browser-state.ts:121`); `BrowserCoreResolvedTarget` (`browser-core.ts:61-67`) is the
  snapshot-scoped identity an adapter gets back for an opaque ref:
  `{ element, snapshotId, generation, frameId, frameRef }`.

### 1.4 Command, image, input and cancellation flow

- **Commands**: `send(method, params, sessionId, options)`; params are
  `BrowserTransportCommandParams = Record<string, unknown>` (`browser-transport-types.ts:2`).
  Browser Core's own shorthand is `cdp<T>(session, method, params)` (`browser-state.ts:325`) and
  `evaluate<T>(session, expression)` (`browser-state.ts:353`).
- **Mandatory provider error codes** (`browser-transport.ts:66-73`): providers must reject caller
  cancellation with `code: "ABORTED"` and a deadline with `code: "BROWSER_OPERATION_TIMEOUT"`, so
  Browser Core can reset a connection whose late command may still reach Chromium. The code set is
  `BrowserOperationInterruptionCode = 'ABORTED' | 'BROWSER_OPERATION_TIMEOUT' |
  'BROWSER_TRANSPORT_CLOSED'` (`operation-timeout.ts`), built by
  `browserTransportInterruptionError()` and classified by `isBrowserOperationInterruption()`.
  `browserOperationFailure()` renders the public `{ success: false, code, error, label?, timeoutMs? }`.
- **Cancellation** flows: `BrowserCoreSession.execute(action, input, signal)`
  (`browser-core.ts:258`) creates one `AbortController`, forwards the caller's abort, sets a timer,
  and stores the signal as `state.commandSignal`. On interruption it calls
  `transport.stopLoading()`, runs `cdpHelper.recoverTransportAfterInterruption(...)`, then
  `invalidate(...)` and sets `poisoned` when recovery/settlement fails (`:336-353`). A poisoned
  session reports `requiresRecreation` (`:205`) and every later action throws
  `BROWSER_SESSION_POISONED`.
- **Screenshots**: `Page.captureScreenshot` in `browser-action-artifacts.ts:65,75`; providers may
  override via the optional seam `BrowserScreenshotCapture`
  (`browser-state.ts:97-100`, wired at `browser-core.ts:57` / `:150`).
- **Input**: `Input.dispatchMouseEvent` (`cdp-helper.ts:1302,1309,1335,1401`),
  `Input.dispatchKeyEvent`, `Input.insertText`, `Input.dispatchDragEvent`
  (`cdp-helper.ts:1362-1377`), `Input.setInterceptDrags` (`:1330`).
- **Deadlines** (`operation-timeout.ts`): `cdpCommand: 30_000`, `cdpScan: 30_000`,
  `tabOperation: 60_000`, `longTabOperation: 125_000`, `ipcHandler: 275_000`, nested
  "inner settles before outer".

### 1.5 Connection state and reconnect

- The **only** reconnect seam is the optional `resetConnection()` (`browser-transport.ts:39-46`).
  Browser Core calls it through `CDPHelper` (`cdp-helper.ts:217`, `:269`); `cdp-helper.ts:224`
  comments that a provider "must implement resetConnection so timeout recovery is page-safe".
- Reference implementation: `packages/tui/src/runtime/browser/headless-chrome-transport.ts:604`
  (`resetConnection`), forwarded by `headless-chrome-provider.ts:648`.
- Session poison/reset: `browser-core.ts:205` `requiresRecreation`, `:264-268`
  `BROWSER_SESSION_POISONED`, `:300-353` recovery + settlement.
- `synchronizeGeneration(n)` (`browser-core.ts:251`) lets a host invalidate refs after navigation it
  observed outside Browser Core.

---

## 2. The CDP commands browser-core issues today (the restricted set)

Distinct method names, by domain, with the issuing file. This is the baseline a Full CDP gate
extends.

**Page** — `Page.navigate` (`browser-actions.ts:203`), `Page.navigateToHistoryEntry` (`:245`),
`Page.reload` (`:276`), `Page.getFrameTree` (`:348`), `Page.getNavigationHistory` (`:359`),
`Page.getLayoutMetrics` (`cdp-page-scanner.ts:453`), `Page.captureScreenshot`
(`browser-action-artifacts.ts:65,75`), `Page.enable` (`cdp-page-scanner.ts:188`,
`cdp-helper.ts:441`), `Page.setInterceptFileChooserDialog`, `Page.stopLoading`
(`browser-snapshot.ts:650`), `Page.fileChooserOpened` (event, `browser-action-artifacts.ts:135`),
`Page.downloadWillBegin` / `Page.downloadProgress` (events, `browser-action-artifacts.ts:135,163`).

**DOM** — `DOM.getDocument` (`cdp-page-scanner.ts:101,215`; `browser-action-targets.ts:173`),
`DOM.querySelector` (`:179`), `DOM.querySelectorAll` (`cdp-page-scanner.ts:118`), `DOM.describeNode`
(`:127`; `browser-action-targets.ts:186`), `DOM.resolveNode` (`browser-actions.ts:1043`),
`DOM.getBoxModel` (`cdp-page-scanner.ts:465`; `browser-action-targets.ts:276`),
`DOM.getContentQuads` (`cdp-page-scanner.ts:603`), `DOM.getFrameOwner` (`:451`),
`DOM.getAttributes`, `DOM.getOuterHTML`, `DOM.pushNodesByBackendIdsToFrontend`, `DOM.enable`
(`:167`; `cdp-helper.ts:490`), `DOM.scrollIntoViewIfNeeded` (`browser-action-targets.ts:73`),
`DOM.focus` (`browser-actions.ts:826,1117`; `browser-extended-actions.ts:333`),
`DOM.setFileInputFiles` (`browser-extended-actions.ts:314`), `DOM.setAttributeValue`;
DOM mutation events consumed at `cdp-helper.ts:528-532` (`DOM.childNodeInserted`,
`DOM.childNodeRemoved`, `DOM.attributeModified`, `DOM.attributeRemoved`,
`DOM.characterDataModified`, `DOM.documentUpdated`).

**Runtime** — `Runtime.evaluate` (`cdp-page-scanner.ts:638`; `browser-snapshot.ts:594`),
`Runtime.callFunctionOn` (`browser-actions.ts:1052`; `browser-extended-actions.ts:382`),
`Runtime.getProperties` (`cdp-page-scanner.ts:756`), `Runtime.releaseObject`
(`browser-actions.ts:1091`; `browser-extended-actions.ts:394`; `cdp-helper.ts:1009`),
`Runtime.enable` (`cdp-helper.ts:380,513`); events `Runtime.executionContextCreated/Destroyed/
Cleared`, `Runtime.exceptionThrown`, `Runtime.exceptionRevoked`, `Runtime.consoleAPICalled`.

**Input** — `Input.dispatchMouseEvent`, `Input.dispatchKeyEvent`, `Input.insertText`,
`Input.dispatchDragEvent`, `Input.setInterceptDrags`, and the `Input.dragIntercepted` event.

**Accessibility** — `Accessibility.enable` (`cdp-page-scanner.ts:181`),
`Accessibility.getFullAXTree` (`:227`).

**DOMSnapshot** — `DOMSnapshot.enable` (`cdp-page-scanner.ts:173`), `DOMSnapshot.captureSnapshot`
(`cdp-page-scanner.ts:206`).

**Network** — `Network.enable` (`cdp-helper.ts:380,499`); events `Network.requestWillBeSent`,
`Network.responseReceived`, `Network.loadingFinished`, `Network.loadingFailed` (used by the console
collector, `cdp-helper.ts:499-513`). **No Network domain command is issued for interception —
`Fetch.*` is never used.** Verified: `grep -rn "Fetch\." packages/browser-core/src` → **no hits**.

**Target** — browser-core *consumes* `Target.detachedFromTarget` (`browser-core.ts:190`) but issues
no `Target.*` command; target attach/flattening is the provider's job. Verified: `grep -rn
"attachToTarget\|setAutoAttach" packages/browser-core/src` → **no hits**.

**Browser** — `Browser.downloadWillBegin` / `Browser.downloadProgress` as **events** only
(`browser-action-artifacts.ts:163`).

Summary: browser-core's ordinary Browser Use path needs Page, DOM, Runtime, Input, Accessibility,
DOMSnapshot, plus Network/Target **events**. It does **not** issue `Fetch.*`, `Network.setRequest*
`, `Storage.*`, `Emulation.*`, `CSS.*`, `Security.*`, `Performance.*`, `ServiceWorker.*` or any
`Target.*` command. That list is the restricted set a Full CDP gate must widen.

---

## 3. Element references, staleness, and "target generation"

### 3.1 Refs are opaque, snapshot-scoped, and generation-fenced

`ElementRecord` (`browser-state.ts:37-58`) carries `ref`, `nodeId`, `backendNodeId`, `tag`, `role`,
`type`, `selector?`, `text`, `rect`, `coordinateSpace`, `isInteractable?`, `frameId?`,
`commandSessionId?`, `frameOffset?`, `parentRegionPath?`, `virtualEditor?`, `attributes`.

`Snapshot` (`browser-state.ts:60-87`) carries `id`, **`generation`**, `createdAt`,
`lastAccessedAt?`, `continuationKind?`, `elements`, `semanticSource?`, `semanticTree`, `page`,
`durationMs?`, `nextOffset`, `continuationInvalidated?`, `frameRefs?`, `editableQuery?`.

**A "target generation" concept already exists**, but it is **page/session-scoped, not tab-scoped**:

- `BrowserSessionState.generation: number` (`browser-state.ts:106`), initialised to `0`
  (`browser-core.ts:145`), exposed by `get generation()` (`browser-core.ts:200`).
- Invalidation is one method, `BrowserActionTargetSupport.invalidate`
  (`browser-action-targets.ts:332-338`):
  ```ts
  protected invalidate(session: SessionState): void {
    session.generation += 1;
    session.frameEpochs?.clear();
    session.elementMap.clearOpaqueRefs();
    clearBrowserSnapshots(session);
    session.keyboardContinuationTarget = undefined;
  }
  ```
- **What makes a ref stale**: `getBrowserSnapshot` returns `undefined` when
  `snapshot.generation !== session.generation` **or** `continuationInvalidated === true`
  (`browser-state.ts:176-181`); `resolveBrowserSnapshotElement` skips snapshots whose generation
  differs (`browser-state.ts:193`); pruning uses the same test plus a 5-minute TTL
  (`browser-state.ts:145`, `:306`), retaining at most `MAX_RETAINED_BROWSER_SNAPSHOTS = 3`
  (`browser-state.ts:144`).
- Ref authority: `BrowserCoreSession.resolveOpaqueRef` (`browser-core.ts:210-219`) consults the
  snapshot store first; the `ElementMapManager` opaque-ref map is a **fixture-only fallback**,
  disabled once `snapshotAuthorityEstablished === true`.

### 3.2 What triggers invalidation today

`BrowserCoreSession`'s event listener (`browser-core.ts:162-193`):

| Event | Scope | Effect |
| --- | --- | --- |
| `Page.frameNavigated` | child frame | `invalidateBrowserFrame` |
| `Page.frameNavigated` | main | full `invalidate` |
| `Page.navigatedWithinDocument` | child / main | same split |
| `Page.frameDetached` | main frame id | full `invalidate`; else frame-scoped |
| `Target.detachedFromTarget` | by `params.sessionId` | frame-scoped |

Plus post-interruption `invalidate` (`browser-core.ts:352`) and host-driven
`synchronizeGeneration()` (`:251`).

### 3.3 Frame-scoped staleness (the OOPIF case)

`BrowserFrameIdentity = { frameId?, commandSessionId? }` (`browser-state.ts:139-142`).
`invalidateBrowserFrame(session, identity)` (`browser-state.ts:224-254`) bumps per-frame epochs in
`session.frameEpochs`, removes matching elements from every retained snapshot, sets
`continuationInvalidated = true`, deletes the frame from `frameRefs`, filters `editableQuery`, and
clears a matching `keyboardContinuationTarget`.

**Gap for the feature**: there is no notion of *tab*/browser-target generation. `generation` is a
per-`BrowserCoreSession` page counter, and a session is per page. Selecting a different tab, closing
a tab, or reconnecting a provider produces a *different session object*, not a bumped generation on
one. A WebUI-owned target-generation layer (WP1) is therefore **must be created**, and it must map
its own target generation onto `BrowserCoreSession` instances.

### 3.4 The legacy ElementMap cache (not the production ref path)

`ElementMapManager` (`element-map-manager.ts:113`) is an LRU cache keyed by `host + pathname`
(`getUrlPath`, `:164`) with `maxCacheSize` default 5 (`:142`), optionally persisted to
`element-map-<domain>-<md5>.json` (`:178-186`). It is **not** how refs are validated in production —
§3.1 applies. `update()` (`:194`) writes the entry; `getElementById`/`getElementBySelector`
(`:322`, `:330`) look up by index/selector. Do not treat this cache as the staleness mechanism.

---

## 4. browser-core package entry point

- Package: `@mavis/browser-core`, private, ESM. **Single subpath `"."`** only
  (`packages/browser-core/package.json`), `types: "./src/index.ts"`, runtime `./dist/index.js`.
  There is no `./contracts` or `./transport` subpath; an implementer imports the root.
- `packages/browser-core/src/index.ts` re-exports the provider-neutral surface:
  `BrowserTransport`, `BrowserAttachedFrame`, `BrowserPageLifecycle`, `CdpTransport`,
  `CoreBrowserEvaluateOptions`, `CoreBrowserTransportEvent(EventListener)` (`index.ts:72-81`);
  `BrowserPageTransport` + non-prefixed `BrowserEvaluateOptions` (`:1-6`); `BrowserTransportCommandParams`
  (`:71`); contracts `BrowserDOMNode/BrowserAXNode/BrowserSnapshotNode/BrowserInteractiveElement/
  BrowserWaitInput/BrowserWaitState` (`:20-31`); `BrowserCore`, `BrowserCoreSession`,
  `BrowserCoreResolvedTarget` via `export * from './browser-core.js'` (`:36`); `ElementMapManager`
  (`:47`); `cdp`, `evaluate`, `ElementRecord`, `BrowserSessionState`, `PageSummary`, `Snapshot`
  (`:49-70`); `BROWSER_TIMEOUTS`, interruption helpers (`:48`).
- Note the duplicated aliases: `BrowserEvaluateOptions` and `BrowserTransportEvent` are exported
  **both** prefixed and unprefixed (`index.ts:1-6` vs `:72-81`). Import the unprefixed
  `CoreBrowser*`-free pair or the prefixed pair consistently — **not verified which the WebUI gate
  will require; needs check**.
- `BrowserCoreSessionOptions` (`browser-core.ts:43-58`) is what a provider passes to
  `createSession(transport, options)` (`:108-113`): `clipboardProvider?`, `cdpHelper?`,
  `actionTimeoutMs?`, `commandTimeoutMs?`, `inputCoordinateScaleProvider?`,
  `beforePointerAction?`, `clickNavigationDetectionMs?`, `captureScreenshot?`.
  The action allow-list is per-provider: `BrowserCoreOptions.actions` asserted by `assertAction`
  (`:92-96`).

---

## 5. WebUI client conventions for a new business

### 5.1 The five roles and what each may do

From `docs/client/ownership.md` ("Businesses own resources; roles own kinds of code") and
`docs/architecture/module-map.md`:

| Role | Owns | Must not |
| --- | --- | --- |
| `contracts/` | published surface: capability port slice, view models, commands | import implementation |
| `application/` | workflows, state owners, query coordination | touch browser globals, DOM, storage, concrete transport |
| `projection/` | pure derivations wire/owned-state → render shape | import React, perform IO |
| `bindings/` | React subscriptions, context, navigation, DOM effects | acquire write authority, construct owners |
| `ui/` | presentation | call IO ports, instantiate owners, reach a generic store writer |

Not every business populates every role; empty directories are not created
(`module-map.md`, "Client — businesses"). A business with no screen has no `ui/`.

**`projection/` classification** (`boundaries.md`): a pure derivation is `domain` if its basename is
in `PROJECTION_DOMAIN` in `scripts/lib/webui-dependency-rules.mjs` (a business rule), otherwise
`view` (reads/shapes only). **Adding a projection that carries a rule means adding its basename to
that list.**

### 5.2 Worked example — the `goal` business (small; populates all five roles)

`packages/webui/src/client/features/goal/` — exact directory list:

```
goal/contracts/goal-port.ts
goal/projection/goal-state.ts
goal/application/goal-coordinator.ts
goal/application/goal-session-owners.ts
goal/application/goal-submission.ts
goal/bindings/goal-owner.public.ts
goal/ui/GoalBanner.public.tsx
goal/ui/goal.css
```

Naming conventions observed:

- **contracts** — `<business>-port.ts`. One `Webui<Business>Port` with every method **optional**
  (`goal-port.ts:16-28`; the header says "`undefined` means 'the operation is not wired'") plus a
  narrow `Webui<Business>Commands` slice of the methods presentation may call
  (`goal-port.ts:11-15`). Requests/responses come from `shared/contracts/<domain>.js`.
- **application** — `<business>-coordinator.ts` holds *policy*; `<business>-session-owners.ts` holds
  *whose* policy it is and when it exists. `goal-coordinator.ts:22` defines
  `WebuiGoalPortSlice = Pick<GoalPort, …>`; `WebuiGoalSink` (`:34`) is the single injected store
  write. Both files state "Framework-free: no React, no DOM."
- **projection** — `<business>-state.ts`, pure, no React.
- **bindings** — hooks, `.public.ts`.
- **ui** — `Webui<Thing>.public.tsx` + `<business>.css`.

### 5.3 Publishing a contract to other modules (the `.public.ts` marker)

Rule (`boundaries.md`): "A feature may use another feature's public `contracts/`, or a module that
feature published as its surface: a `.public.ts` for a derivation or interface, a `.public.tsx` for a
component. Everything else in another feature is private, and there is no exception list."

A published module is constrained: "every explicit export is public, no export-star, no foreign
re-export, and no foreign namespace, default or dynamic access" (`boundaries.md`). Enforced by
`classifyRole` / `ROLE_FORBIDDEN_TARGETS` in `scripts/lib/webui-dependency-rules.mjs` via
`pnpm check:webui-dependency`, with baseline `scripts/lib/webui-dependency-baseline.json`.

Concrete example — `goal/bindings/goal-owner.public.ts` publishes
`webuiGoalRecordKey(sessionId)`, `useWebuiGoalOwner(sessionId): WebuiGoalCoordinator` and
`useWebuiGoalReaction(sessionId, listener)`. It reads the owner from the application
(`useWebuiApplicationOptional()` / `application?.goals`) and falls back to a per-mount registry so a
composer mounted without an application still works. A settings or workspace surface that needs the
goal owner imports **only** this `.public.ts` module.

Other examples: `review/application/workspace-review-owner.public.ts`,
`models/bindings/use-provider-editor.public.ts`, `terminal/projection/terminal-size.public.ts`,
`workspace/projection/workspace-name.public.ts`, `settings/ui/SettingsModal.public.tsx`.

### 5.4 Composition root and lifetime (ADR 0016/0017/0018 rules, per `docs/client/ownership.md`)

- The composition root is `client/application/create-application.ts`. It constructs **dormant**
  owners, then start installs routes, hydrates persisted state and starts ingress. It is the only
  place that knows which capability is wired.
- `dispose()` is idempotent; a disposed instance cannot restart; a fresh lifecycle gets fresh
  identity epochs.
- Exactly **one** process-event ingress per application instance: the single long-lived
  `watchEvents` subscription (`client/platform/event-channel.ts`).
- Temporal ownership rules: interest leases; generation fences (one live stream lease per session);
  incarnation + freshness (`client/application/identity-epochs.ts`,
  `client/conversation/request-freshness.ts`); keyed resources vs selected slots.
- `WebuiTransport` (`client/contracts/transport.ts:31-45`) extends the thirteen business ports; it
  "declares no method of its own" and every method is optional.
- `client/bindings/` (`application-context.tsx`, `use-query-state.tsx`, `browser-capabilities.tsx`,
  `browser-effects.ts`, `navigation.ts`, `port-slices-context.tsx`, …) is the **only** React edge
  to application owners. `use-query-state.tsx:1-10` states components "read its snapshot and submit
  query commands, and they never receive a transport method or a store writer".

### 5.5 The tui ban — nuance

`boundaries.md` says "Never import `packages/tui` (ADR 0003). Read it as a specification, compose the
equivalent here." It is not implemented as a literal `packages/tui` denylist entry in
`webui-dependency-rules.mjs`; the load-bearing facts are structural:
`packages/webui/package.json` declares **no** dependency on a tui package, and
`scripts/lib/webui-dependency-rules.mjs` has no allow-list of tui subpaths, so an import would
simply be an unresolvable workspace dependency. `packages/browser-core` is the sanctioned read-only
reference (it is a separate workspace package, in `release/extraction.json` `packageRoots`).
**Not verified — needs check:** whether `check:webui-dependency` would emit a specific message for a
tui import or merely fail to resolve it.

---

## 6. Settings controls

### 6.1 Where they live

- Settings business: `src/client/features/settings/` — `contracts/settings-port.ts`,
  `contracts/memory-handoff.ts`, `projection/{settings-view,usage-report,usage-plan}.ts`,
  `application/settings-workflows.ts`, `ui/*` (17 files), plus `ui/SettingsModal.public.tsx`.
- Skeleton primitives are shared, business-free: `client/ui/settings-layout.tsx` exports
  `SettingsPage` (`:35`), `SettingsSection` (`:47`), `SettingsCard` (`:86`), `SettingsRow` (`:101`),
  `SettingsDivider` (`:133`), `InfoHint` (`:153`). `client/ui/ToggleSwitch.tsx:14` exports the shared
  switch.
- Tabs and their enabled/disabled state come from **one** derivation:
  `features/settings/projection/settings-view.ts` — `SettingsTabKey` (`:11`),
  `DESKTOP_SETTINGS_TABS` (`:15`), `resolveThemePreference` (`:20`), `filterSettingsTabs` (`:22`),
  `SETTINGS_GROUPS` (`:24`). `ownership.md` notes `voice`, `shortcuts` and `connection` are declared
  but disabled.

### 6.2 How a control is written

`ToggleSwitch` props (`client/ui/ToggleSwitch.tsx:3-12`): `Omit<ButtonHTMLAttributes<HTMLButtonElement>,
"aria-checked" | "aria-label" | "onChange" | "role" | "type"> & { checked, label,
onChange?: (checked: boolean) => void, testId?, … }`. It renders a `<button role="switch"
aria-checked={checked}>` and calls `onChange?.(!checked)` (`:22-36`). Consumers: `:5`,
`client/features/settings/ui/UsageModelSettings.tsx:5`, `MemorySection.tsx:10`,
`models/ui/ProviderFormPanel.public.tsx:45`, `settings/ui/SettingsModal.public.tsx:29`,
`plugins/ui/PluginManagementList.tsx:5`.

### 6.3 Concrete toggle that calls a business owner instead of owning state

`features/settings/ui/UsageModelSettings.tsx:231` — the credit-fallback toggle:

```tsx
<ToggleSwitch
  checked={creditFallback.enabled === true}
  label="M Plan 达限后使用积分"
  disabled={creditFallback.saving}
  onChange={(next) => { void account?.setCreditFallback(next); }}
  testId="settings-usage-credit-fallback-toggle"
  className="shrink-0 disabled:opacity-60" />
```

The chain: component → `account` owner command → `features/account/application/account-workflows.ts:333`
(`readonly setCreditFallback: (enabled: boolean) => Promise<void>`; implementation `:770`) →
port method `features/account/contracts/account-port.ts:32` →
`client/platform/transport.ts:254` (`request(SET_CREDIT_FALLBACK_OPERATION_NAME, body)`) →
`client/application/port-slices.ts:203`.

The settings component owns **only** the busy/error presentation; `enabled`/`saving` come from the
owner's state. A browser authorization toggle must follow the same shape: render the switch from a
browser business's published projection/commands, never write persistence itself.

### 6.4 Persistence

`application/settings-workflows.ts:29` states "This module is framework-free — no React, no DOM, no
storage". Storage IO lives in `client/platform/storage.ts` behind `WebuiBrowserStorage`
(`:16-40`), with key constants such as `WEBUI_COMPOSER_STATE_KEY = "webui.composer.state.v1"`
(`:15`), `NO_PROJECT_STORAGE_KEY`, `TEAM_MODE_STORAGE_KEY`. Server-persisted settings go through
operations instead (e.g. `getMemorySettings` / `setMemorySettings`).

---

## 7. Workspace panels

`features/workspace/ui/WorkspacePanels.tsx` is the panel surface. Composition is ordinary React
composition plus a **tab dispatch**:

- Tab kinds are a closed union: `WebuiWorkspaceTabShapes` → `WebuiWorkspaceTabKind` (`keyof`)
  → `WorkspacePanelTab = { [K in Kind]: { id, kind: K } & Shapes[K] }[Kind]`
  (`projection/workspace-panel-state.ts:64-70`), with labels and add-menu entries in
  `WEBUI_WORKSPACE_TAB_KINDS` (`:88-93`): `files`, `file-preview` (`addMenu: null` — opened by a path
  from the tree, never by the menu), `review`, …
- Commands are the panel's contract: `WorkspacePanelCommand` in
  `features/workspace/contracts/panel-command.ts` (re-exported at `workspace-panel-state.ts:75`).
- `WebuiFilePreview` (`WorkspacePanels.tsx:304-334`) dispatches **before** consulting the read
  result: archive first, then HTML, then loading/error, then media, then binary, then markdown/code.
  `html` is rendered at `:315-316`:
  ```tsx
  const html = !archive && isWorkspaceHtmlPath(tab.path) && workspaceFileUrl
    ? <WorkspaceHtmlPreview path={tab.path} fileUrl={workspaceFileUrl({…})} content={result?.content} />
    : undefined;
  ```
- Panel-level controls: `WebuiWorkspacePanelControls` (`:283`), `WebuiProgressOverviewPanel` (`:290`),
  `WebuiWorkspacePanel` (`:333`) taking `state`, `dispatch`, `workspaceFileUrl` and the Terminal
  business's published owner.
- `ownership.md` / the panel file record that panel re-exports (`WorkspacePanels.tsx:72-77`) exist
  because panel tests import them — "the panel's public surface".

### 7.1 What the HTML preview actually is (confirmed: not a control surface)

`features/workspace/ui/WorkspaceHtmlPreview.tsx:1-30`:

- It renders `<iframe src={fileUrl}>` pointing at the `/workspace-file` route. "That is the whole
  isolation story."
- The route answers `text/html` with `Content-Security-Policy: sandbox allow-scripts` → opaque
  origin: scripts run, but the document cannot read `window.__WEBUI_CONFIG__.token`, touch the
  panel's DOM, or use the WebUI origin for storage.
- "No `sandbox` attribute here" — one layer, in the server, so the boundary stays auditable.
- "Never `srcdoc`, never a blob URL, never `dangerouslySetInnerHTML`."
- `projection/html-preview.ts` only *reports* relative references
  (`hasRelativeDocumentReference`), because relative URLs 404 under the opaque origin.

It is a read-only local-file preview with no input forwarding, no target selection and no CDP
surface. **Repurposing it is ruled out** (also stated in the plan §3).

---

## 8. Transport bindings for server operations

### 8.1 Operation names — the single declaration point

`packages/webui/src/shared/operation-names.ts`. Shape, verbatim:

```ts
export const VERSION_OPERATION_NAME = "version" as const;          // :12
export const LIST_SESSIONS_OPERATION_NAME = "listSessions" as const; // :13
export const GET_GOAL_OPERATION_NAME = "getGoal" as const;           // :29
// …
export interface OperationSpec {                                     // :255
  version: { request: undefined; response: WebuiVersionInfo };
  listSessions: { request: WebuiSessionListRequest; response: WebuiSessionPage };
  isGoalEnabled: { request: undefined; response: WebuiGoalEnabledResult };
  getGoal: { request: { readonly sessionId: string }; response: WebuiGoal | undefined };
  patchGoal: { request: WebuiGoalPatchRequest; response: WebuiGoal };
  // …
}
export const WEBUI_STREAM_OPERATION_NAMES = [                       // :623
  SEND_MESSAGE_OPERATION_NAME, RESUME_SESSION_OPERATION_NAME,
  WATCH_EVENTS_OPERATION_NAME, WATCH_TERMINAL_OPERATION_NAME,
] as const;
export type WebuiStreamOperationName = (typeof WEBUI_STREAM_OPERATION_NAMES)[number]; // :645
export type WebuiUnaryOperationName = Exclude<keyof OperationSpec, WebuiStreamOperationName>; // :652
```

Header comment (`:1-10`): `OperationSpec` "is the single declaration point for what an operation
carries in and what it answers with"; `server/operation/bind-handlers.ts` is checked against it.
The file "lives in `shared/` and therefore imports only shared contracts, never the runtime port".

Naming: lowerCamelCase wire name; SCREAMING_SNAKE constant prefixed by the verb (`GET_`,
`LIST_`, `SET_`, `PATCH_`, `CREATE_`, `WATCH_`, `RESUME_`, `SEND_`, `MUTATE_`, …). A browser
operation follows the same shape: constant + `OperationSpec` entry, no string literals anywhere
else.

### 8.2 The client binding pattern a browser operation would follow

`client/platform/transport.ts` is "the domain method table: every capability the browser client can
ask the host for, joined to the wire" (`:1-10`). Mechanics live in `./wire.js`.

1. Import the `*_OPERATION_NAME` constant (never a literal) — see the import block at `:21-95`.
2. Add one method to the object: `patchGoal: (body) => request(PATCH_GOAL_OPERATION_NAME, body)`
   (`:187`), `isGoalEnabled: () => request(IS_GOAL_ENABLED_OPERATION_NAME, undefined)` (`:184`),
   `listTerminals: () => request(LIST_TERMINALS_OPERATION_NAME, {})` (`:221`).
3. Streams differ: `watchTerminal: (body, onFrame) => watchTerminal(WATCH_TERMINAL_OPERATION_NAME, body, onFrame)` (`:226`);
   `sendMessage` / `resumeSession` use `stream(...)` (`:228`, `:231`).
4. Register the operation name in the business port (`client/contracts/transport.ts` joins ports),
   `client/application/port-slices.ts` (`:203` lists capability keys), the server descriptor
   (`server/operation/<domain>.ts`) and `WEBUI_OPERATION_BINDINGS`.

---

## 9. Exists today vs. must be created

**Exists today**

- `BrowserTransport` provider contract + `CDPHelper`/`BrowserCoreSession` action path
  (`browser-transport.ts`, `cdp-helper.ts`, `browser-core.ts`).
- The restricted CDP command set (§2).
- Page-scoped generation + snapshot-scoped opaque refs + per-frame epochs (§3).
- Structured interruption codes and reset/reconnect seams (§1.4, §1.5).
- A provider adoption seam in WebUI runtime (`runtime/browser-provider.ts`).
- The five-role business layout and `.public.ts` publication mechanism (§5).
- Settings skeleton + `ToggleSwitch` + the owner-command toggle pattern (§6).
- Workspace tab dispatch and the iframe HTML preview (§7).
- The operation-name / `OperationSpec` declaration point (§8).

**Must be created**

- WebUI shared DTOs + validators for browser config, per-browser authorization, pairing/connection
  status, tab inventory, active target, input, image stream, stable failures.
- The `features/browser/` client business (contracts / application / projection / bindings / ui) and
  its owner, fenced by a **tab-level** target generation (§3.3 gap).
- Server operations + `bind-handlers` entries + runtime routing for browser ops; the Full CDP gate
  in the runtime/provider path.
- The extension package (`packages/browser-extension/`), its packaging and its verify gate.
- Any WebUI → browser-core import path (§10 caveat).

---

## 10. Open risks for the implementer

1. **`@mavis/browser-core` is not a WebUI dependency today.**
   `packages/webui/package.json` dependencies contain no browser-core entry, and browser-core's only
   consumer is `packages/tui` (`packages/tui/src/runtime/browser/{headless-chrome-transport,
   headless-chrome-provider, headless-cdp-connection}.ts`). Adding the dependency is a real change
   with dependency-rule consequences. **Not verified — needs check:** whether
   `pnpm check:webui-dependency` / `check:webui-boundary` permit a new workspace dependency, and
   whether browser-core's `private: true` + `dist/index.js` resolution is viable inside the WebUI
   build (the WebUI bundle consumes `@mavis/local-runtime-v2` and `@mavis/protocol` today).
2. **client bundle must stay browser-side.** `BrowserTransport` implementations own a process; only
   *contracts* may cross into `client/`.
3. **Target generation is a new concept.** browser-core's `generation` is per page session, not per
   browser target; do not assume it can carry tab selection.
4. **`browserActionArtifacts` download observation depends on `Page.download*` /
   `Browser.download*` events** (`browser-action-artifacts.ts:135,163`) — an extension `chrome.debugger`
   provider may not surface them; WP0's capability matrix must answer this.
5. **Settings are split**: client-side (`client/platform/storage.ts`, `localStorage` keys) versus
   server-persisted operations. Browser authorization is stateful and cross-device-relevant; decide
   which side owns persistence before writing the toggle.
6. **`Full CDP` and `restricted` sets**: §2 is the current restricted set as of this commit. Any new
   browser-core CDP call silently widens it — the gate should be derived from the provider's declared
   capabilities, not a hard-coded list that drifts.