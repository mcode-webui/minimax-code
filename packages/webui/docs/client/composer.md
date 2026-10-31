# Composer

The Composer's fields do not share one reset policy. This table is the contract; a change to any row
needs its own behavioural evidence — browser or assembled-application, per
[`../verification/gates.md`](../verification/gates.md).

| Field | Selection / home adoption | Surface hide / remount | Submit / dispose |
| --- | --- | --- | --- |
| Draft and input history | Select the persisted slot; home adoption moves home draft/history transactionally | Slots retained | Record committed input at the existing timing; preserve branch-specific clearing; disposal retains persisted bytes |
| Attachments / URLs / busy / seed | Preserve carryover; no automatic per-session cache or switch clearing | Store stays application-owned; DOM input attachment may remount | Clear submitted arrays on direct-send start and on successful enqueue; goal and command submissions do not universally clear staging; disposal revokes obsolete IO commit rights |
| Goal input mode | Reset or reconcile on eligible selection / enable-state transition; the retained canonical goal is not cleared | Reacquire view and reconcile | Goal entry disables plan mode; a successful goal submission derives the mode from the result |
| Plan input mode | No blanket session-switch reset | Retained as application state | Explicit goal/plan commands govern transitions; live mode discarded on disposal |
| Queue mirror | One selected destination with a generation, not a per-session mirror map; home display gates preserved | Refresh view interest without recreating the owner | Enqueue / delete / read commit only to an eligible destination generation; settlement obligations survive a selection change |
| Retry | Last `{session, message}` retained, shown only for the matching session and refusal, never retargeted by adoption | Retained | Retry enters the ordinary send/enqueue workflow; goals and commands create no turn-retry record |
| Mention and slash | Mention retained until an explicit command; slash derived from draft and caret | Recreate caret, index and listeners | Selection/dismiss controls the range; no universal switch or submit reset |
| Send and newline keys | The bindable keys are the stored bindings, not a rule in the component; the settings page owns the change | The stored binding is read when a key is pressed, so a rebinding takes effect without a remount | 发送消息 submits and 换行 breaks the line; a press that names neither binding is left to the browser; an open IME composition belongs to the composition |

## Where the pieces live

- The surface is `client/features/composer/ui/WebuiComposer.tsx`, with the editor staging, menus,
  submission controls, permission control, project row and queue panel beside it in the same `ui/`
  directory. The model picker it renders lives in the models business
  (`client/features/models/ui/ModelPicker.public.tsx`), and it owns the thinking level: there is no
  thinking control in the composer's own toolbar to disagree with it.
- The owner, the controller, the queue and the persisted store are in
  `client/features/composer/application/` (`composer-controller.ts`, `composer-queue.ts`,
  `composer-store.ts`, `composer-history.ts`, `command-workflows.ts`, `turn-retry.ts`).
- The pure field rules — record, normalize, recall, prune, migrate the home slot — are
  `composer-history.ts` plus the feature's projections. `client/bindings/composer-store.ts` is the
  React-side store binding.
- The submission path itself (creation, admission, send-or-queue) is
  [`submission.md`](submission.md).
- The keyboard bindings live in the settings business: the page is
  `client/features/settings/ui/ShortcutsSettings.tsx` with its own model in
  `client/features/settings/projection/settings-shortcuts.ts`, and the notation both the page and the
  composer read is `client/projection/common/shortcuts.ts`. The composer keeps no binding state —
  it reads the stored binding when a key is pressed. ADR
  [`../adr/0026-the-composer-follows-the-bindings-the-settings-page-stores.md`](../adr/0026-the-composer-follows-the-bindings-the-settings-page-stores.md)
  records why.
