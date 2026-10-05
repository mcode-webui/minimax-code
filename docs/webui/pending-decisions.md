# Pending decisions — WebUI H task (模型与用量)

Open questions raised while porting roadmap task H from the other WebUI
implementation onto this repository's `packages/webui`. Each one is a decision
that was deliberately NOT made, with the reason it is still open and what a
decision would change.

Nothing here is a bug report. These are choices between two defensible answers,
and picking one without the user would be picking for them.

---

## 1. Does the depth level on the model chip take a separator before it?

**Status:** open. Shipped as 6px of space, deliberately reversible.

### What renders today

The model chip names the level beside the model, in the muted tertiary colour:

```
M3.1-Flash-Preview  max  ⌄
```

The two are separated by the chip's existing `gap-[6px]`. The two source
implementations disagree on this point:

| Source | Separator | Rendered |
| --- | --- | --- |
| `minimax-code-web` `chipLevelSuffix` | `" · "` (middle dot, spaced) | `M3.1-Flash-Preview · max` |
| The example screenshot this task was built from | 6px of space | `M3.1-Flash-Preview  max` |

The screenshot was followed, because the task is a port of a described design
and the screenshot is the design. The source implementation's middle dot was
not copied.

### Why this is a real question and not a nitpick

The chip is the only place the level is named, and the brain icon beside it
already answers a different question — whether thinking is on. With 6px of
space, `M3.1-Flash-Preview max` reads as one label describing one model. With a
middle dot, the dot draws a line between a model and a setting, which is
arguably the more honest reading: the level is not part of the model's name and
was never part of it.

Against that, a middle dot inside a pill is punctuation the surrounding UI
mostly avoids, and at 12px tertiary weight it can read as a smudge on a
long model name. That is a rendering judgement, not something to settle by
argument.

### What a decision changes

One token, in `ModelPicker.tsx` — the suffix the chip renders. No behavioural
consequence: the level is reachable either way, and the brain icon's behaviour
is independent of how the chip separates its two values.

### How to decide

Render both against the longest model name in the catalogue at 12px tertiary
weight, and pick the one that still reads as two things at a glance. Do not
decide from the source implementation alone — it was written against a
different chip.

---

## 2. The thinking switch does not persist

**Status:** open. Blocked on a runtime contract this repository does not have.

### Symptom

On a two-state model (M3), the brain icon is a real button and accepts clicks.
Committing a click does not stick: the icon returns to its unstated state.

This is NOT the same as the disabled-button bug fixed in `a440ad5`. That fix
made the control operable; this is the control being operable and the runtime
discarding the result.

### Root cause

`resolveEffortOptions` (`ModelPicker.tsx`) decides a model is a two-state
switch from `thinkingConfig.mode === "switchable"` PLUS a
`supportedVariants` array containing both an empty and a non-empty entry:

```ts
if (model.thinkingConfig?.mode === "switchable") {
  const variants = model.supportedVariants ?? [];   // always undefined
  const hasOff = variants.includes("");
  const hasOn = variants.some((variant) => Boolean(variant));
  if (hasOff && hasOn) return ["off", "on"];
}
```

`supportedVariants` is declared on the client contract
(`client/contracts.ts:102`) but **not** on the server's `WebuiModelEntry`
(`server/port.ts:739-758`). The server never sends it, so the branch never
runs, and the option list falls through to whatever `effortOptions` carries.

The model's own configuration is correct and complete — `~/.minimax/config.yaml`
gives M3 both `variants: { none-thinking, thinking }` and
`thinking_config: { mode: switchable }`. The data exists; it stops at the
webui port.

A second mismatch sits behind it: `variantForEffort` returns `""` for "off",
while the configured variant is named `none-thinking`. Even with the field
wired through, turning thinking OFF would send a name the model does not have.

### Why it is not fixed here

The fix is a data-contract change, not a UI change: add `supportedVariants` to
`WebuiModelEntry`, populate it from the model's configured `variants`, and
teach `variantForEffort` the `none-thinking` spelling. That crosses into
`local-runtime-v2`'s model system, which is outside the scope of "port the H
task's UI".

It is also pre-existing, not introduced by this branch: the dependency on
`supportedVariants` dates to `0536fce`, and before `a440ad5` the button was
disabled outright, so the same pick never persisted. This branch made the
failure visible by making the control work.

### What a decision changes

- **Fix now** — the switch becomes a switch. Two files in `local-runtime-v2`,
  one field in `server/port.ts`, one branch in `ModelPicker.tsx`.
- **Fix separately** — this branch merges with the icon and menu work; the
  contract gap gets its own change with its own review.

### How to decide

Nothing about the UI argues either way. The only question is whether a runtime
contract change should ride along with a UI port or land on its own.
