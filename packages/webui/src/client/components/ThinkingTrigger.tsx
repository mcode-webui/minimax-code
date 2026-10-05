/**
 * The composer's thinking trigger: a brain icon, and nothing else.
 *
 * The brain belongs to the TWO-STATE model alone. A model with only a thinking
 * switch gets a button: press it and thinking turns on, press it again and it
 * turns off, without opening anything. That is what makes it a control rather
 * than a label.
 *
 * A model with a DEPTH scale gets no brain at all. It is not a switch, so there
 * is nothing to press — a brain there would have to pick low/medium/high on the
 * user's behalf, which is precisely the question a binary control cannot ask. It
 * used to render a non-interactive grey glyph to "indicate" the level, but a
 * control-shaped thing that cannot be controlled is an affordance for a choice
 * the user then has to make somewhere else. The level is already on the model
 * chip ("M3.1-Flash-Preview max"), and it is CHOSEN in the model picker's
 * settings fly-out — so the value is stated once and editable once, and the
 * toolbar carries no dead glyph beside it.
 *
 * The trigger is the ICON ALONE at rest. 「开启」 in a label said what the brain
 * beside it already said, two controls apart in the same toolbar.
 *
 * Hovering it says what the press will do, in the shell's own bubble — the same
 * dark shape the context ring beside it uses. It was a native `title`, and a
 * native title is drawn by the window chrome rather than by the page: it arrives
 * late, it is styled by nothing here, and in this shell it did not arrive at
 * all, so a control whose entire job is to be pressed looked inert until it was
 * pressed. The ring two buttons away had a real bubble, which is what made the
 * inconsistency read as this one being broken rather than as a platform quirk.
 */
import { useState, type ReactElement } from "react";

import {
  brainHoverLabel,
  brainTone,
  resolveThinkingVerdict,
  thinkingControlShape,
  type BrainTone,
} from "../projection/thinking-control.js";

/**
 * A brain glyph.
 *
 * The Lucide `brain` outline, at its native 24×24 grid and 2px stroke. It is
 * inlined rather than pulled from an icon package: this is the only place in
 * the shell that draws a brain, and a one-off dependency plus a one-off import
 * is a second thing to keep in step with the design tokens. The path data is
 * Lucide's, unmodified — an icon redrawn by eye is a different icon, and this
 * one has to stay recognisable to anyone who has seen it elsewhere.
 *
 * `strokeWidth` is the 1.4 the shell's other glyphs use, not Lucide's 2: the
 * brain is drawn in a 20px box here rather than 24, so the same nominal stroke
 * would render visibly heavier than the icons beside it.
 */
function BrainGlyph({ className }: { readonly className?: string }): ReactElement {
  return (
    <svg
      viewBox="0 0 24 24"
      aria-hidden="true"
      className={className}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M12 18V5" />
      <path d="M15 13a4.17 4.17 0 0 1-3-4 4.17 4.17 0 0 1-3 4" />
      <path d="M17.598 6.5A3 3 0 1 0 12 5a3 3 0 1 0-5.598 1.5" />
      <path d="M17.997 5.125a4 4 0 0 1 2.526 5.77" />
      <path d="M18 18a4 4 0 0 0 2-7.464" />
      <path d="M19.967 17.483A4 4 0 1 1 12 18a4 4 0 1 1-7.967-.517" />
      <path d="M6 18a4 4 0 0 1-2-7.464" />
      <path d="M6.003 5.125a4 4 0 0 0-2.526 5.77" />
    </svg>
  );
}

/**
 * The tone's class name, written out in full.
 *
 * NOT `` `webui-thinking-brain--${tone}` ``. Tailwind's `components` layer is
 * purged against the class names it can find as complete literals in the
 * client sources, and an interpolated one is not one: the scanner sees
 * `webui-thinking-brain--` and stops. Every rule keyed to the three tone
 * classes was therefore dropped from the built stylesheet while the component
 * went on emitting them, so the brain rendered in whatever colour it inherited
 * and the one thing this control exists to signal never appeared — with no
 * error anywhere, because a purged rule is a successful build.
 *
 * A map with the full names is what the scanner can read, and it is the same
 * shape `is-active` already uses elsewhere in the shell.
 */
const TONE_CLASS: Readonly<Record<BrainTone, string>> = {
  on: "webui-thinking-brain--on",
  off: "webui-thinking-brain--off",
  unstated: "webui-thinking-brain--unstated",
};

export interface ThinkingTriggerProps {
  /** The active model's resolved thinking options. Empty renders nothing. */
  readonly options: readonly string[];
  /** The active model's recorded effort, if any. */
  readonly recorded: string | undefined;
  /**
   * The active model's wire variant — a two-state model's actual on/off state.
   *
   * Read here because the switch's state lives in the variant and nowhere else:
   * a model with no depth has no effort to record, so an on/off commit writes
   * the variant and leaves `recorded` untouched.
   */
  readonly variant?: string;
  readonly preview: boolean;
  readonly onChange: (option: string) => void;
}

export function ThinkingTrigger({
  options,
  recorded,
  variant,
  preview,
  onChange,
}: ThinkingTriggerProps): ReactElement | null {
  const shape = thinkingControlShape(options);
  // A no-op control is worse than none, so an empty list renders nothing at all
  // rather than a control whose clicks change nothing.
  if (shape === null) return null;
  if (shape !== "switch") return null;

  const on = resolveThinkingVerdict(options, {
    ...(variant !== undefined ? { variant } : {}),
    thinkingEffort: recorded,
  });
  const tone = brainTone(on);
  // One title for the button, read from the tone rather than from `on`
  // separately — the two always agree, and a caller free to pass both is a
  // caller free to pass them disagreeing.
  const hover = brainHoverLabel(tone);
  const [hovered, setHovered] = useState(false);

  // A two-state model's brain IS the switch — the whole point of it is that
  // thinking turns on and off from here without opening anything. So an
  // UNSTATED verdict must not disable it.
  //
  // Disabling on `on === null` made the control dead in exactly the state a
  // session starts in: nothing recorded yet, because the user has not touched
  // it. A control that cannot be used until something else has already used it
  // is not a switch. The engine's default is a state the toggle acts on, not a
  // state that locks it — clicking commits an explicit "on", which is a fact
  // the user stated rather than one inferred.
  //
  // `aria-pressed` stays false while unstated: the brain is not claiming
  // thinking is on, it is offering to turn it on.
  // `aria-hidden` because the button's own label already announces this, and a
  // bubble that repeats what assistive technology was just told is read twice.
  // The label is the visible half only.
  return (
    <span
      className="webui-thinking-anchor"
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <span
        className="webui-thinking-label"
        aria-hidden="true"
        data-webui-thinking-label={hovered && !preview ? "true" : "false"}
      >
        {hover}
      </span>
      <button
        type="button"
        // Disabled rather than absent while previewing: the control exists for
        // the model under the pointer, and saying so by removing it would make
        // the toolbar jump around as the pointer crosses rows.
        disabled={preview}
        aria-pressed={on === true}
        aria-label={hover}
        className="webui-thinking-trigger"
        data-webui-thinking-trigger="true"
        data-webui-thinking-tone={tone}
        onClick={() => onChange(on === true ? "off" : "on")}
      >
        <BrainGlyph className={`webui-thinking-brain ${TONE_CLASS[tone]}`} />
      </button>
    </span>
  );
}
