# Architecture and source map

Paths are repository-relative. Start structural work with `packages/webui/docs/architecture/design.md`; use `layered-model.md`, `module-map.md`, and `boundaries.md` for detail. Confirm their claims against touched source and tests.

## Execution boundaries

| Boundary | Responsibility | Source under `packages/webui/src/` |
| --- | --- | --- |
| Browser client | Owners, projections, React surfaces, browser IO | `client/main.tsx`, `client/application/create-application.ts` |
| Loopback server | HTTP/WS admission, envelope/body validation, dispatch and delivery | `server/service.ts`, `server/access-policy.ts`, `server/operation/operation-dispatch.ts` |
| Process-local runtime | Host assembly, adapters, authentication/resource lifecycle, PTYs | `runtime/assembly.ts`, `runtime/lifecycle.ts`, `runtime/harness/adapter.ts` |
| Shared contracts | Wire names, DTOs, frames, capability facts | `shared/operation-names.ts`, `shared/contracts/`, `shared/envelope.ts` |

Browser → authenticated loopback service → `WebuiHarnessPort` → process-local harness. The port call is an in-process adapter seam, not another network hop. WebUI builds on `@mavis/local-runtime-v2`; it does not launch the CLI or import `packages/tui`. TUI may be read for behavior/event semantics. Local `src/shared/` and the workspace package `@mavis/shared` are different homes.

## The browser's own boundary

The browser runtime lives in `src/runtime/browser/` and the external bridge in `src/server/browser-bridge/`. Both reach a real browser through `@mavis/browser-core`, a **peer** workspace package (`packages/browser-core/`) rather than a WebUI layer.

| Concern | Owner | Where |
| --- | --- | --- |
| What a browser action *means* — element references, retained snapshots, action deadlines, effect validation | `@mavis/browser-core` | `packages/browser-core/src/` |
| How a command reaches one page or tab | a `BrowserTransport` adapter, one per surface | `src/runtime/browser/isolated-chromium/core-transport.ts`; `src/server/browser-bridge/core-transport.ts` |
| Whether an action *may* run | the WebUI | `src/runtime/browser/authorization.ts`, `src/runtime/browser/browser-service.ts` |

**The rule that keeps this honest:** Browser Core decides what an action means, the WebUI decides whether it may run, and a transport decides only how the command travels. A transport never judges an action's meaning, and the core reads no authorization switch.

When changing a browser action, an element reference, or the bridge's command path, read `packages/webui/docs/browser-use/10-browser-core-integration.md` first. Two consequences are easy to miss:

- **Do not re-implement an action's semantics in a provider.** A provider that translates a restricted action into raw DevTools calls itself is a second definition of what the action does, and the two will drift. Add the capability to the core, or extend the transport — not the provider's action switch.
- **`src/client/` and `src/shared/` may not import `@mavis/browser-core`.** The dependency gate rejects it, and the reason is structural: the browser bundle must not carry a second, unreachable copy of the core's semantics. This is why the restricted command vocabulary is duplicated in `src/shared/contracts/browser.ts` rather than read from the core; `test/unit/browser-restricted-commands.test.ts` asserts the two lists cannot drift. If you add an action, update both and let the test tell you.

The two surfaces are not interchangeable, and the differences are properties of the browsers rather than of the WebUI's knowledge: the bridge cannot `open_tab` (`chrome.debugger` cannot open a page in the person's browser) and cannot `upload_files` (`DOM.setFileInputFiles` is deliberately absent from the extension's allowlist). The bridge's screenshot comes from the extension's pushed visible-tab frame, so a tab that is not in front is refused rather than answered with another tab's picture.

## Client placement

Paths here are under `packages/webui/src/client/`.

| Home | Owns | Boundary |
| --- | --- | --- |
| `main.tsx` | Concrete transport/storage/DOM wiring and React mount | Side-effectful entry; do not import it as a library |
| `application/` | Assembly, canonical session record, selectors, epochs, task creation | Framework-free; receive IO capabilities rather than concrete adapters |
| `conversation/` | Freshness, selected slots, interests, stream mechanics, transcript history | Mechanisms do not reach feature implementation, platform or assembly |
| `features/<business>/application/` | Business decisions, commands, mutations and resource truth | No React, browser globals or concrete transport |
| `features/<business>/contracts/` | Capability slices, commands, view types | Leaf declarations, not implementation forwarding barrels |
| `features/<business>/projection/` | Pure classification and view derivation | No IO/React; policy-bearing derivations classify as domain |
| `features/<business>/bindings/` | Hooks/subscriptions bridging owners to React | Read owners and invoke commands; do not acquire writer authority |
| `features/<business>/ui/` | Presentation and business CSS | No business RPCs, owner construction or generic store writes |
| `bindings/`, `platform/` | React/browser effects; browser IO adapters | Business policy belongs to owners |
| `projection/common/` | Pure shared geometry, routes and value shaping | No business owner |
| `shell/`, `ui/` | Surface composition; business-independent primitives | Shell creates no owners; generic UI reaches no business |

Create only needed roles. A feature-root `.ts` file without a role directory classifies unknown. A business can own resources without owning a screen.

## Business routing

This is a starting map, not a frozen registry. Rediscover files with `rg --files packages/webui/src/client/features` and follow callers. Paths below are within the named feature unless stated otherwise.

| Business | Change here for | Useful source |
| --- | --- | --- |
| `sessions` | Catalogue, unread, archive/delete/fork/import/export, rail | `application/session-workflows.ts`, `session-catalog.ts`, `unread.ts`; `ui/SessionRail.tsx` |
| `composer` | Draft/history/staging, captured input, slash commands, queue/retry | `application/composer-controller.ts`, `composer-store.ts`, `command-workflows.ts` |
| `turn` | Admission, send/resume/attach, stream generation/phase, process-event policy | `application/turn-commands.ts`, `submission-admission.ts`, `event-coordinator.ts`, `session-fact.ts` |
| `transcript` | Message/tool projection, Markdown, scroll, feedback | `projection/transcript-projection.ts`, `message-projection.ts`; `ui/SessionTranscript.tsx`, `markdown.public.tsx` |
| `interactions` | Permissions, questionnaires, plan approval | `application/interaction-coordinator.ts`, `interaction-session-owners.ts` |
| `goal` | Goal reads, create/patch submission and session ownership | `application/goal-coordinator.ts`, `goal-submission.ts`, `goal-session-owners.ts` |
| `models` | Catalogue selection, providers/discovery/tests, editor | `application/models-workflows.ts`, `provider-editor.ts` |
| `settings` | Personalization/profile/memory, preference surfaces and theme | `application/settings-workflows.ts`, `projection/settings-view.ts`, `ui/SettingsModal.tsx` |
| `account` | Login/status/quota/check-in and polling | `application/account-workflows.ts` |
| `plugins` | Plugin/skill/app/MCP/agent listings and mutations | `application/plugin-workflows.ts`, `composer-catalogue.ts`, `contracts/plugin-actions.ts`, `ui/PluginCatalogue.tsx` |
| `workspace` | Files/environment/archives/canvas, panel choices | `application/workspace-queries.ts`, `workspace-*-owner.ts`, `ui/WorkspacePanels.tsx` |
| `review` | Turn changesets and working-tree snapshot resources | `application/turn-review-owner.ts`, `workspace-review-owner.public.ts` |
| `terminal` | Browser terminal catalogue, commands, watches | `application/terminal-owner.ts`; service owns processes |
| `scheduling` | Scheduled tasks: list, create, edit, enable/disable, delete, run now, run history; whether this client holds a task | `application/scheduling-owner.ts`, `projection/scheduling-panel.ts`, `ui/SchedulingPanel.public.tsx`, `ui/scheduling-editor.tsx`; decision: `docs/adr/0027-the-webui-is-a-scheduler-host-for-scheduled-tasks.md` |
| `browser` | Per-target browser state, authorization switches, the panel host | `application/browser-commands.ts`, `application/browser-authorization.ts`, `projection/browser-state.ts`, `ui/BrowserPanelHost.public.tsx`; semantics are `@mavis/browser-core` |
| `miniapp` | Mini App catalogue, open/stop, the standalone tab and the agent bridge | `application/miniapp-workflows.ts`, `application/miniapp-bridge.ts`, `projection/miniapp-view.ts`, `ui/MiniAppView.public.tsx` |
| `shell` | Boundary errors and surface shaping | `application/boundary-error.ts`, `projection/shell-surface.ts` |

Settings hosting an editor does not transfer Models ownership. Workspace rendering a PTY does not own its process. Transcript rendering an interaction does not own reply policy. A named use case may coordinate multiple owners, as `client/application/task-session-workflows.ts` does.

## Executable dependency rules

Read `scripts/lib/webui-dependency-rules.mjs` and `scripts/check-webui-dependency.mjs` before changing imports/classification. The checker resolves TypeScript references, including erased type-only edges.

- `classifyLayers` and `classifyRole` are separate. A layer-legal edge can violate privacy, presentation authority or ownership.
- `ALLOWED_EDGES` permits identity edges and allows `view`/`domain` cross-edges. Do not invent a strict descending DAG from a picture.
- `PROJECTION_DOMAIN` decides which projection basenames carry policy; `.public` is stripped before lookup. Classify new policy-bearing projections there.
- Peer `contracts/` and published `.public.ts`/`.public.tsx` are reachable subject to other rules. Private peer implementation is not.
- Publication keeps the role. Explicit owned exports are public; export-star and foreign re-exports/namespace/default/dynamic access cannot launder implementation into an API.
- Server reaches `runtime/port.ts`, not runtime implementation. Browser never reaches that port or Node. Shared declarations reach neither execution side.
- A move updates every importer and removes old forwarding shims. Do not add allowances to conceal ownership changes.

A green graph proves encoded compliance, not use-case cohesion, temporal correctness, portability or platform behavior.
