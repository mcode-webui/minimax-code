/**
 * The composer's thinking trigger: a brain icon, and nothing else.
 *
 * The brain is a SWITCH for a two-state model and a plain INDICATOR for a depth
 * scale. That asymmetry is deliberate: a clickable brain on a depth scale would
 * have to pick one of low/medium/high on the user's behalf, and which depth
 * someone wants is precisely the question a binary control cannot ask. So on a
 * depth scale the brain is not a button at all.
 *
 * For a two-state model the brain is the ONLY thinking control in the composer,
 * and it is the fast path: press it and thinking turns on, press it again and
 * it turns off, without opening the model picker. That is what makes it a
 * button rather than a label, and it is why an unstated record must leave it
 * operable — see the switch branch below.
 *
 * It is also the only control here. A level control used to sit beside it, and
 * that was one value stated twice: the model chip already names the level where
 * it names the model ("M3.1-Flash-Preview max"), so a second control repeating
 * that word one slot along the toolbar answered nothing the chip had not. The
 * level is CHOSEN in the model picker's settings fly-out, which is where the
 * thinking row already is.
 *
 * The trigger is the ICON ALONE. 「开启」 in a label said what the brain beside
 * it already said, two controls apart in the same toolbar.
 */
import type { ReactElement } from "react";

import {
  brainHoverLabel,
  brainTone,
  isThinkingOn,
  resolveEffortCurrent,
  thinkingControlShape,
} from "../projection/thinking-control.js";

/**
 * A brain glyph. Inline SVG rather than an icon-module entry: it is the only
 * place in the shell that draws one, and an icon module export used once is a
 * second thing to keep in step with the design tokens.
 */
function BrainGlyph({ className }: { readonly className?: string }): ReactElement {
  return (
    <svg
      viewBox="0 0 20 20"
      aria-hidden="true"
      className={className}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M10 3.5a3 3 0 0 0-3 3 2.5 2.5 0 0 0-1.5 4.4A2.6 2.6 0 0 0 7 15.4a2.4 2.4 0 0 0 3 1.1Z" />
      <path d="M10 3.5a3 3 0 0 1 3 3 2.5 2.5 0 0 1 1.5 4.4A2.6 2.6 0 0 1 13 15.4a2.4 2.4 0 0 1-3 1.1Z" />
      <path d="M10 3.5v13" />
    </svg>
  );
}

export interface ThinkingTriggerProps {
  /** The active model's resolved thinking options. Empty renders nothing. */
  readonly options: readonly string[];
  /** The active model's recorded effort, if any. */
  readonly recorded: string | undefined;
  /** True while the picker is describing a model that is not the active one. */
  readonly preview: boolean;
  readonly onChange: (option: string) => void;
}

export function ThinkingTrigger({
  options,
  recorded,
  preview,
  onChange,
}: ThinkingTriggerProps): ReactElement | null {
  const shape = thinkingControlShape(options);
  // A no-op control is worse than none, so an empty list renders nothing at all
  // rather than a control whose clicks change nothing.
  if (shape === null) return null;

  const on = isThinkingOn(options, recorded);
  const tone = brainTone(on);
  // The hover title still names the level: the chip states it, but a tooltip is
  // where a pointer actually goes for "which level is this".
  const current = resolveEffortCurrent(options, recorded, preview);
  const levelLabel = current === null ? undefined : current;

  const brain = (
    <BrainGlyph className={`webui-thinking-brain webui-thinking-brain--${tone}`} />
  );

  if (shape === "switch") {
    // A two-state model's brain IS the switch — the whole point of it is that
    // thinking turns on and off from here without opening anything. So an
    // UNSTATED record must not disable it.
    //
    // Disabling on `on === null` made the control dead in exactly the state a
    // session starts in: no effort recorded yet, because the user has not
    // touched it. A control that cannot be used until something else has
    // already used it is not a switch. The engine's default is a state the
    // toggle acts ON, not a state that locks it — clicking commits an explicit
    // "on", which is a fact the user stated rather than one inferred.
    //
    // `aria-pressed` stays false while unstated: the brain is not claiming
    // thinking is on, it is offering to turn it on.
    const disabled = preview;
    const hover = brainHoverLabel(tone, levelLabel, on === true ? "turn-off" : "turn-on");
    return (
      <button
        type="button"
        // Disabled rather than absent while previewing: the control exists for
        // the model under the pointer, and saying so by removing it would make
        // the toolbar jump around as the pointer crosses rows. An unstated
        // record no longer disables it — see above.
        disabled={disabled}
        aria-pressed={on === true}
        aria-label={hover}
        title={hover}
        className="webui-thinking-trigger"
        data-webui-thinking-trigger="true"
        data-webui-thinking-tone={tone}
        onClick={() => onChange(on === true ? "off" : "on")}
      >
        {brain}
      </button>
    );
  }

  // A depth scale's brain only states the current level, so there is no action
  // to name in its title.
  const hover = brainHoverLabel(tone, levelLabel);

  return (
    <span
      className="webui-thinking-brain-slot"
      title={hover}
      data-webui-thinking-indicator={tone}
    >
      {brain}
    </span>
  );
}
