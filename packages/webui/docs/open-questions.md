# Open questions

Decisions deliberately not made. Each entry says what ships today, what a decision would change, and
where to look. These are choices between two defensible answers; picking one without the operator
would be picking for them. Nothing here is a bug report.

## 1. Does the model chip's depth level take a separator before it?

**Status:** open, shipped as 6px of space, deliberately reversible.
`client/features/models/ui/ModelPicker.public.tsx` renders `<span className="flex min-w-0 items-baseline
gap-[6px]">` and the level span beside it, with no separator token anywhere in `features/models/`.

- **Today:** `M3.1-Flash-Preview  高` — the 6px gap reads as one label at 12px tertiary weight. The
  level is shown in the interface's language, not the wire's, since the wire speaks `high` and the
  interface speaks Chinese.
- **Alternative:** a middle dot (`·`) draws an explicit line between a model and a setting.
- **How to decide:** render the longest catalogue name at both settings and compare; the gap choice
  was made reversible precisely so this is a one-line change.

## 2. Does a committed thinking/variant choice survive a reload?

**Status:** open, and unmeasured. The data-contract half of the original question is settled: the
`supportedVariants` field is declared on the wire contract (`shared/contracts/models.ts`) and
populated by the server projection (`server/projections/model-provider.ts`), and the thinking
control reads the switch from `mode === 'switchable'` plus `supportedVariants` / `default_value`
(`client/features/models/projection/thinking-control.ts`).

What has not been measured: a grep of `features/composer/application/` and `client/platform/storage.ts`
finds no persistence of the chosen variant or effort, and no test covers reload survival. The browser
therefore behaves as "the choice is per composer session" until someone measures it.

- **What a decision would change:** whether the selection joins the persisted composer state
  (`webui.composer.state.v1`) or stays in memory.
- **How to decide:** one browser pass — pick a non-default level, reload, observe. Record the
  observation here and close the question.

## 3. May this browser surface reach every connected App?

**Status:** open, with no decision recorded anywhere. The mcode-tools broker is what makes the
connector tools work (`known-gaps.md` §1). Enabling it for the WebUI means an agent running in a
loopback-reachable browser page can call every App the user has connected on this machine.

- **What a decision would change:** whether the beta feature stays the only gate, whether a
  per-surface permission is introduced, or whether connector access stays off for this client.
- **Why it is not a mechanical fix:** ADR 0004 binds the service to loopback and validates Host and
  Origin, which protects against other machines, not against a local page or a second local user. The
  same question class was already recorded for Computer Use; the answer there does not transfer
  automatically.

## 4. Is `titleSafetyBypass: true` the WebUI's permanent value?

**Status:** closed on 2026-10-29 — the answer was no. The `webui` row was aligned with Desktop's
`electron` row, and `execution.titleSafetyBypass` is now `false`, the value every non-terminal
client already had (`packages/local-runtime/src/runtime/runtime-owner-policy.ts`, `webui` row).

- **What the decision changed:** WebUI session titles go through the safety filter again instead of
  bypassing it. The cell is no longer a provisional value carried by the identity row.
- **What was not measured:** a title-generation comparison across both settings on real sessions was
  never run, so the user-visible delta of the flip is not quantified here.

## 5. What does a tab show when the page behind it is closed?

**Status:** open, listed as unsettled by
[ADR 0022](adr/0022-webui-workspace-panel-is-a-browser-tab-strip.md) and decided nowhere.

- **Today:** a closed target is kept rather than dropped, so it stays in the panel's list labelled
  closed and stays selectable (`WebuiBrowserTargetStatus` is `"open" | "closed"`, and `isCurrent`
  refuses it as stale); the stage behind it falls back to its empty-picture notice, because a closed
  page pushes no frames. There is no tab to lose either way: the browser tab is the panel's own
  `browser` kind, not a slot holding a page.
- **Answered.** [ADR 0022](adr/0022-webui-workspace-panel-is-a-browser-tab-strip.md) decides it and
  the tree carries it: **a closed web tab closes its page**, and the runtime's page set follows the
  strip (`runtime/browser/browser-service.ts` — `closeWebTab` closes the page and forgets the
  target). A tab always names a live page, and closing a page and closing a tab are one command.
- **What a decision would change:** whether the strip may hold a tab whose content is absent, and
  whether closing the last page closes the tab — which decides whether closing a page and closing a
  tab are one command or two.
- **How to decide:** one pass against a real isolated Chromium — close the page behind a tab and
  observe what the strip should keep — and record the observation here.
