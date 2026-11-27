# Composer

The session composer's decorative chibi octopus girl uses a transparent animated WebP through `<picture>`.
Reduced motion selects a matching transparent PNG first frame, which also serves as the fallback
for browsers without WebP support. Both assets have the same aspect ratio, so switching media
does not move the decoration. The character rests on the card's top edge. This image path avoids
depending on video alpha decoding or autoplay support; its generated source and conversion are
recorded in the asset manifests.

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

Runnable slash commands clear the captured draft as soon as execution starts; newer typing remains
in the composer. `/compact` progress and its one-line completion summary appear at the bottom of the
matching session's transcript. Other command output remains with the composer.

Retained input from an externally deleted session is merged only by the notice's explicit action.
The composer store's `mergeInput` validates attachment and URL identities before changing any field,
appends nonempty source text, and publishes the complete draft and staging together. Empty source
text preserves the target draft. Synchronous subscribers can edit the committed input without a
later transfer write replacing their changes. Conflicts publish nothing and keep the retained source;
the notice shows a transfer error beside its action so the user can select another destination and retry.

## Workspace folder selection

On the home page, `选择新项目` opens the system folder chooser in the browser
paired by an interactive local `mcode-webui` launch. Windows opens the native
`IFileOpenDialog` from a short-lived koffi worker, which also brings the dialog
to the foreground when the server was started in the background; macOS uses its
system dialog. On a Linux desktop the launcher uses Zenity or KDialog. Zenity opens
in the last folder confirmed during this launch if it still exists, or in the user's
home directory. This lets the chooser open even if a desktop application previously
selected a folder that has since been removed. Confirming
a folder sets its absolute path as the working directory for the next session.
Cancelling returns to the home page with the previous selection.

The tab opened by the launcher exchanges its temporary grant for a browser key
and a separate HttpOnly session cookie. Reloaded pages and other tabs on the
same origin use that pairing. After a restart, the launcher tab renews it for
the browser. A remote or unpaired browser can select a recent project or
`不需要项目`. Requesting a new folder without a native chooser displays a notice.

A local desktop host that embeds the page can receive the same grant URL through
`WEBUI_LAUNCH_URL_FILE` when it starts `mcode-webui` with `WEBUI_DESKTOP_HOST=1`.
The file is owner-only and the grant remains one-time; the route's loopback,
Host, Origin, cookie, grant and browserKey checks are unchanged. `WEBUI_OPEN_BROWSER`
still controls only the system browser.

## Where the pieces live

- The surface is `client/features/composer/ui/WebuiComposer.tsx`, with the editor staging, menus,
  submission controls, permission control, project row and queue panel beside it in the same `ui/`
  directory. The model picker it renders lives in the models business
  (`client/features/models/ui/ModelPicker.public.tsx`), and it owns the thinking level: there is no
  thinking control in the composer's own toolbar to disagree with it.
- The surface keeps the input: the draft and its caret, the menus, the toolbar and the rows it
  draws. Four flows that are not rendering are bindings beside it, so a change to one does not
  travel through the others:
  - `bindings/use-composer-permission-mode.ts` — the permission mode's read, its write and the
    popover's open/busy/unavailable state. The component supplies the error slot and the trigger.
  - `bindings/use-composer-catalogue.ts` — the installed plugins and the runtime's skill roster,
    each with its own loading and failure state, plus the scope-following re-read the slash pool
    needs. Sectioning the palette stays with the surface that renders it.
  - `bindings/use-composer-goal-mode.ts` — entering and leaving goal and plan mode, the enable
    probe, the goal re-read and whether the draft came from the banner's edit affordance.
  - `bindings/use-composer-submission.ts` — the two outbound requests, submit and retry. The wire
    intent itself is `projection/submit-intent.ts`, so which fields travel is asserted without
    rendering anything.
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
