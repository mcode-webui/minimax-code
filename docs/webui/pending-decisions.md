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

## 2. Does a committed thinking choice survive a reload?

**Status:** open, and the symptom behind it is now **unverified**. It is
recorded here because the control's contract gap is real; the behaviour it used
to cause has not been re-measured since the escape hatch landed.

### What was measured, and when

The symptom this section originally described was: on a two-state model (M3) the
brain icon accepts a click and then returns to its unstated state — the control
was operable and the result discarded. That was a live observation at the time.

**It has not been reproduced since.** A browser run after this branch merged
confirmed the toggle now emits `variant: "thinking"` when switched on and
`variant: ""` when switched off (`variantForEffort`, `ModelPicker.tsx:302`).
Nobody has checked whether either survives a page reload, which is what the
original symptom was actually about. Until someone does, treat the old symptom
as history, not as the current state.

This is NOT the same as the disabled-button bug fixed in `a440ad5`. That fix
made the control operable at all.

### The contract gap that remains real

`resolveEffortOptions` (`ModelPicker.tsx:252`) infers that a model is a
two-state switch from `thinkingConfig.mode === "switchable"` PLUS a
`supportedVariants` array holding both an empty and a non-empty entry:

```ts
if (model.thinkingConfig?.mode === "switchable") {
  const variants = model.supportedVariants ?? [];
  const hasOff = variants.includes("") || variants.includes("none-thinking");
  const hasOn = variants.some((variant) => variant && variant !== "none-thinking");
  const declaredSwitch = model.thinkingConfig?.default_value !== undefined;
  if ((hasOff && hasOn) || declaredSwitch) return ["off", "on"];
}
```

`supportedVariants` is declared on the client contract
(`client/contracts.ts:140`) but **still not** on the server's `WebuiModelEntry`
— it appears nowhere in `server/port.ts`, so the server never sends it and the
`hasOff && hasOn` inference never runs.

What changed is the second half of that condition. `declaredSwitch` reads
`thinkingConfig.default_value`, and `thinkingConfig` **is** on the server
contract (`server/port.ts:870`). So the switch now surfaces through the
runtime's own statement that the model has one, and no longer depends on a
second field arriving intact. That is why the symptom above is unverified
rather than confirmed: the path that used to fail is no longer the one being
taken.

The model's configuration is complete — `~/.minimax/config.yaml` gives M3 both
`variants: { none-thinking, thinking }` and `thinking_config: { mode:
switchable }`.

### Correction: there is no `""` / `none-thinking` mismatch

An earlier revision of this section claimed a second, deeper problem:
`variantForEffort` returns `""` for "off" while the configured variant is named
`none-thinking`, so switching thinking off "would send a name the model does not
have".

**That is wrong, and acting on it would break working code.** The two spellings
are not compared at the same layer. The runtime normalises the catalogue before
it ever reaches the client
(`local-runtime/src/model-provider/list-models.ts:136`):

```ts
.map(([variant]) => (variant === 'none-thinking' ? '' : variant));
```

So a client reading `supportedVariants` sees `["", "thinking"]` — `none-thinking`
does not exist on the wire. Sending `""` is the correct spelling, and the
`variants.includes("none-thinking")` clause in the read side is there for
catalogues that never passed through that normalisation.

### What is actually open

1. **Does the choice survive a reload?** One browser test settles it. Nothing
   about it argues for or against — it is a measurement nobody has taken.
2. **Should `supportedVariants` be wired through anyway?** It would remove the
   reliance on `default_value` as an escape hatch and let the client infer the
   switch from the catalogue. That is a data-contract change: one field on
   `WebuiModelEntry` plus a population site in the runtime's model system, which
   is outside "port the H task's UI".

Both predate this branch. The dependency on `supportedVariants` dates to
`0536fce`, and before `a440ad5` the button was disabled outright, so the same
pick never persisted either. This branch made the control work, which is what
turned the question from "is the button live" into "does the answer stick".
