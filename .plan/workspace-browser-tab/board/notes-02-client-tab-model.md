# Research notes: the client's tab model, and the sites a mutable content breaks

**Reference material for the workspace browser tab model programme — not a work item.**
Do not close this issue as a ticket.

Captured before implementation, from the source at the checkout that carried ADR 0022. These are
the sites the client half of the programme touches. Every line number was checked against that
tree; the tree moves, so re-check before you edit.

Decision authority: ADR 0022
(`packages/webui/docs/adr/0022-webui-workspace-panel-is-a-browser-tab-strip.md`).

## 1. The tab kinds are a fixed enumeration, and four things depend on that

`packages/webui/src/client/features/workspace/projection/workspace-panel-state.ts`

| Site | What it does today | What a mutable content does to it |
| --- | --- | --- |
| `:102-119` | `WEBUI_WORKSPACE_TAB_KINDS` — the kinds, each with a label and an add-menu entry | The kinds become **content descriptors**; `browser` is deleted |
| `:251` | `tabId(kind, …parts)` — the id is derived from the kind, so the browser kind is one tab per session and directory | The id must come from the client instead, so two web tabs in one session are two tabs |
| `:287-289` | Opening a files tab **drops every other files tab** — one files tab per session | That singleton has to be re-thought: it was a consequence of the id, not a policy |
| `:279`, `:283` | The workspace review and the turn review get the **same** id, so one overwrites the other | The two must be able to coexist in one strip |
| `:155-157` | The label is derived from the kind and the review's source | The label follows the content |
| `:299-303` | The tab shape is narrowed on `kind === "review"` | The narrowing follows the content's kind |

## 2. The strip narrows on the kind in 28 places

`packages/webui/src/client/features/workspace/ui/WorkspacePanels.tsx` — the strip's rendering
narrows on `activeTab?.kind` in 28 places (`const tab = activeTab?.kind ?? "files"` at `:206` is
the first). With a mutable content, every one of those guards is a place where the content has to
be read instead.

## 3. The stale-read hazard: a stable id with a changing content

The file results are cached **by tab id** — `fileResults.get(activeTab.id)` at `:291` and `:327` —
and the review summary is matched by tab id — `reviewSummary.tabId === activeTab?.id` at `:339` —
while the effects that read them depend on `[activeTab?.id]`. Today the id changes when the
content does, so the effect re-runs.

With a stable id and a mutable content, **the effect does not re-run** and the component reads
the entry the previous content wrote. A tab that changes from "files" to "a web page" would keep
rendering the file result.

⇒ Either the cache key moves to the content, or the effect's dependency moves to the content, or
both. This is the failure that looks fine in a static render and wrong in the app.

## 4. The panel's input is bound to the panel's own selected target

- `packages/webui/src/client/features/browser/application/browser-commands.ts:282-290` — the input
  command is built from the panel's `state.selectedTarget`.
- Today that field **is** the run's selection: the panel writes it when the person clicks a
  target, and the service publishes it as the run's selection. After the split, the panel's
  selected target is the **tab the person is looking at**, and the run's selection is a separate
  cell. An input that kept following the run's selection would type into a page the person is not
  looking at.

## 5. The panel never polls, and the frame stream is per run

- `packages/webui/src/client/features/browser/ui/BrowserPanelHost.public.tsx:193-196` — the target
  list is re-read on mount and on a surface change, and never on a timer. A selection that changes
  on the runtime's side is therefore invisible to the client until something else triggers a read.
- `packages/webui/src/shared/operation-names.ts:458-461` — `watchBrowserFrames` takes
  `{ surface, runId? }`, so the stream follows the run's selection rather than a target.

## 6. The browser tool tab is the only place a surface is chosen

`packages/webui/src/client/features/browser/ui/BrowserPanel.public.tsx:207` — the surface chips.
They are how a person reaches Edge and Chrome today. Under ADR 0022 the embedded panel is the
isolated browser's view, the chips go with the tab they belonged to, and the external browsers are
driven in the user's own windows.

## 7. The plumbing a new source file and a new test file need

- **A new source file must be recorded in the frozen path metadata.**
  `packages/webui/test/gates/fixtures/path-metadata-f00.json` lists every TypeScript, TSX and CSS
  source path, and `packages/webui/test/gates/webui-dependency-check.test.ts` fails on a path that
  is not in it. The README next to the fixture says how to classify a new path: run the frozen
  baseline classifier against the path after stripping only `.public`, and review any mismatch
  separately. A `.public` file under `client/features/<business>/ui/` is recorded with the
  **un-prefixed** role (`feature-ui`), and the business is the one the path is under.
- **A new Vitest file must be listed in the declared suite groups.**
  `test/vitest-suites.json` — the file never runs if it is not listed.
- **A new Playwright spec must live under `packages/webui/test/browser/`**, or the source check
  rejects it.
- **The published source inventory is regenerated**, not edited:
  `node scripts/source-inventory.mjs --write`.
- **`pnpm gen:tsconfig` is only needed when a package export changes**, which this programme does
  not do.
