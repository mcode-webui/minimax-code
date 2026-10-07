/* Roadmap P 区「语音输入」.
 *
 * There is nothing to fix here and nothing to extend: the client has no
 * `getUserMedia`, no `SpeechRecognition`, and no voice state of any kind. The
 * tab is disabled because there is nothing behind it.
 *
 * So the whole feature rests on one honest question — what does this browser
 * do when nobody is listening? The Web Speech API is Chromium and partly
 * Safari; Firefox has never shipped it. A mic button that appears and then
 * fails is worse than no mic button, because it costs the user a click and
 * tells them nothing. So support detection is a first-class state, not a
 * boolean folded away at the call site, and it is asserted here rather than
 * left to whoever wires the button.
 *
 * The other decision worth freezing is what a recognition result does to text
 * the user has already typed. Interim results arrive continuously and revise
 * themselves, so the state's job is to replace exactly the segment this
 * utterance contributed and leave everything around it alone. Getting that
 * wrong silently eats the user's half-written sentence.
 *
 * Everything here is pure. The webui suite has no jsdom, so the recogniser
 * itself is driven through the state machine and the presentational half lives
 * in `SettingsModal.tsx`.
 */

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { WebuiVoiceSettings } from "../../src/client/components/SettingsModal.js";
import {
  WEBUI_VOICE_LANGUAGES,
  WEBUI_VOICE_SETTINGS_KEY,
  initialWebuiVoiceState,
  reduceWebuiVoiceState,
  resolveWebuiVoiceSupport,
  parseWebuiVoiceSettings,
  subscribeWebuiVoiceSettings,
  writeWebuiVoiceSettings,
  type WebuiVoiceSettings as WebuiVoiceSettingsValue,
} from "../../src/client/projection/voice-state.js";

describe("deciding whether this browser can listen", () => {
  const support = (patch: Partial<Record<"SpeechRecognition" | "webkitSpeechRecognition", unknown>>) =>
    resolveWebuiVoiceSupport(patch as never);

  it("accepts a browser that exposes the recogniser either way", () => {
    expect(support({ SpeechRecognition: class {} })).toBe("supported");
    expect(support({ webkitSpeechRecognition: class {} })).toBe("supported");
  });

  /* Firefox, and any browser where the feature is off. This is the case the
   * mic button has to be built around. */
  it("reports a browser with neither spelling as unsupported", () => {
    expect(support({})).toBe("unsupported");
    expect(support({ SpeechRecognition: undefined })).toBe("unsupported");
  });

  it("does not start a session on a browser that cannot listen", () => {
    const state = reduceWebuiVoiceState(
      { ...initialWebuiVoiceState(), support: "unsupported" },
      { type: "start", draft: "hello", at: 0 },
    );
    expect(state.phase).toBe("idle");
  });

  it("starts a session on one that can", () => {
    const state = reduceWebuiVoiceState(
      { ...initialWebuiVoiceState(), support: "supported" },
      { type: "start", draft: "hello", at: 0 },
    );
    expect(state.phase).toBe("listening");
  });
});

describe("recognised speech into a draft the user has already typed", () => {
  const listening = (draft: string, at = 0) =>
    reduceWebuiVoiceState(
      { ...initialWebuiVoiceState(), support: "supported" },
      { type: "start", draft, at },
    );

  /* The whole point of tracking where the utterance began: the recogniser
   * revises its own interim text, and only that segment may be replaced. */
  it("leaves text before the utterance alone", () => {
    const state = listening("hello ", 6);
    expect(state.segmentStart).toBe(6);
    expect(state.draft).toBe("hello ");
  });

  it("shows interim text as it is still being revised", () => {
    const state = reduceWebuiVoiceState(listening("hello ", 6), { type: "interim", text: "wor" });
    expect(state.interim).toBe("wor");
    expect(state.draft).toBe("hello wor");
  });

  it("replaces the interim segment with the final one", () => {
    const withInterim = reduceWebuiVoiceState(listening("hello ", 6), { type: "interim", text: "wor" });
    const final = reduceWebuiVoiceState(withInterim, { type: "final", text: "world" });
    expect(final.draft).toBe("hello world");
    expect(final.interim).toBe("");
    expect(final.phase).toBe("idle");
  });

  it("keeps text typed after the utterance began", () => {
    const withInterim = reduceWebuiVoiceState(listening("", 0), { type: "interim", text: "hi" });
    const typed = { ...withInterim, draft: "hi there" };
    expect(reduceWebuiVoiceState(typed, { type: "final", text: "hey" }).draft).toBe("hey there");
  });

  it("does not duplicate the segment when the final equals the interim", () => {
    const withInterim = reduceWebuiVoiceState(listening("", 0), { type: "interim", text: "hi" });
    expect(reduceWebuiVoiceState(withInterim, { type: "final", text: "hi" }).draft).toBe("hi");
  });

  it("goes back to idle after a failure, keeping what was recognised", () => {
    const withInterim = reduceWebuiVoiceState(listening("", 0), { type: "interim", text: "part" });
    const failed = reduceWebuiVoiceState(withInterim, { type: "failed", reason: "no-speech" });
    expect(failed.phase).toBe("idle");
    expect(failed.draft).toBe("part");
    expect(failed.error).toBe("no-speech");
  });

  it("clears the error when the next session starts", () => {
    const failed = reduceWebuiVoiceState(
      reduceWebuiVoiceState(listening("", 0), { type: "interim", text: "x" }),
      { type: "failed", reason: "no-speech" },
    );
    expect(reduceWebuiVoiceState(failed, { type: "start", draft: "y", at: 0 }).error).toBeUndefined();
  });

  /* A cancelled session must leave the draft exactly as it was — the user
   * pressed stop, they did not ask for half a word. */
  it("throws away the interim segment when the user cancels", () => {
    const withInterim = reduceWebuiVoiceState(listening("keep ", 5), { type: "interim", text: "junk" });
    const cancelled = reduceWebuiVoiceState(withInterim, { type: "cancelled" });
    expect(cancelled.draft).toBe("keep ");
    expect(cancelled.phase).toBe("idle");
  });

  it("ignores recognition results that arrive with no session running", () => {
    const idle = initialWebuiVoiceState();
    expect(reduceWebuiVoiceState(idle, { type: "interim", text: "ghost" }).interim).toBe("");
  });
});

describe("the recogniser languages the settings page offers", () => {
  it("offers only tags it can label", () => {
    for (const entry of WEBUI_VOICE_LANGUAGES) {
      expect(entry.tag.trim().length).toBeGreaterThan(0);
      expect(entry.label.trim().length).toBeGreaterThan(0);
    }
  });

  it("does not offer the same tag twice", () => {
    expect(new Set(WEBUI_VOICE_LANGUAGES.map((entry) => entry.tag)).size).toBe(WEBUI_VOICE_LANGUAGES.length);
  });
});

describe("settings that survive a reload", () => {
  const defaults: WebuiVoiceSettingsValue = { enabled: false, language: WEBUI_VOICE_LANGUAGES[0]?.tag ?? "zh-CN" };

  it("round-trips a stored object", () => {
    const stored = JSON.stringify({ enabled: true, language: "en-US" });
    expect(parseWebuiVoiceSettings(stored)).toEqual({ enabled: true, language: "en-US" });
  });

  /* localStorage outlives a downgrade of this build and can be edited by
   * hand. A half-recognised value must not leave the mic permanently on. */
  it("falls back for a malformed or partial value", () => {
    expect(parseWebuiVoiceSettings("{nope")).toEqual(defaults);
    expect(parseWebuiVoiceSettings('{"enabled":true}')).toEqual(defaults);
    expect(parseWebuiVoiceSettings('{"enabled":"yes","language":"en-US"}')).toEqual(defaults);
    expect(parseWebuiVoiceSettings(null)).toEqual(defaults);
  });

  it("refuses a language it does not offer", () => {
    expect(parseWebuiVoiceSettings('{"enabled":true,"language":"xx-YY"}').language).toBe(defaults.language);
  });
});

describe("a switch flipped after the page loaded", () => {
  /* The composer reads the setting when it mounts. Without a way to tell it
   * the setting changed, turning voice on in settings and then walking back to
   * the composer leaves the button missing until a reload — the setting page
   * says "on" and the composer says "off", which is the same "structure is
   * right, the thing does not work" failure this row started as. */
  it("tells every reader when the stored settings change", () => {
    const seen: WebuiVoiceSettingsValue[] = [];
    const unsubscribe = subscribeWebuiVoiceSettings((next) => seen.push(next));

    writeWebuiVoiceSettings({ enabled: true, language: "en-US" });
    unsubscribe();
    // After unsubscribing, a later write must not reach this listener.
    writeWebuiVoiceSettings({ enabled: false, language: "ja-JP" });

    expect(seen).toEqual([{ enabled: true, language: "en-US" }]);
  });

  it("persists what it tells the readers", () => {
    // The suite runs in node, where there is no localStorage at all.
    const calls: Array<[string, string]> = [];
    const scope = globalThis as Record<string, unknown>;
    const had = "localStorage" in scope;
    const previous = scope.localStorage;
    scope.localStorage = { setItem: (key: string, value: string) => calls.push([key, value]) };
    try {
      writeWebuiVoiceSettings({ enabled: true, language: "en-US" });
    } finally {
      if (had) scope.localStorage = previous;
      else delete scope.localStorage;
    }
    expect(calls).toEqual([[WEBUI_VOICE_SETTINGS_KEY, JSON.stringify({ enabled: true, language: "en-US" })]]);
  });
});

/* The page renders below. These close the loops a static render cannot: that
 * the tab reaches it, and that the composer has somewhere to put a mic. A mic
 * that no button drives is the same class of defect as the disabled tab. */
describe("wiring", () => {
  const source = readFileSync(
    fileURLToPath(new URL("../../src/client/components/SettingsModal.tsx", import.meta.url)),
    "utf8",
  );
  const composer = readFileSync(
    fileURLToPath(new URL("../../src/client/components/SessionComposer.tsx", import.meta.url)),
    "utf8",
  );

  it("routes the voice tab to its own page", () => {
    expect(source).toContain('{active === "voice" ? <SettingsVoicePage');
    expect(source).toContain('active !== "voice"');
  });

  it("stops disabling the voice tab", () => {
    expect(source).not.toContain('key: "voice", group: "preferences", label: "语音", icon: "voice", disabled: true');
  });

  it("gives the composer a control that starts listening", () => {
    // The testid alone is not the feature: it sits inside the `voice.available`
    // branch, and negative injection showed that a `{false ? …` around it left
    // every assertion here green while removing the button from the composer
    // entirely. Assert the guard and the control as one piece of source.
    expect(composer).toMatch(/\{voice\.available \? \([\s\S]*?data-testid="composer-voice"/u);
  });

  /* The mic must not appear before the user has asked for the feature, and
   * must not appear where the browser cannot listen. */
  it("holds the mic back until the feature is on and the browser can listen", () => {
    const hook = readFileSync(
      fileURLToPath(new URL("../../src/client/use-webui-voice.ts", import.meta.url)),
      "utf8",
    );
    expect(hook).toContain('available: settings.enabled && state.support === "supported"');
  });

  /* The mirror that pushes the reducer's draft back into the composer compares
   * it against what the user has typed. Unguarded, the untouched `""` of a
   * fresh state differs from anything the user wrote, and the composer is
   * cleared on the first keystroke. The guard is the whole fix, so it is the
   * thing asserted here. */
  it("only pushes the reducer's draft back while a voice session owns it", () => {
    const hook = readFileSync(
      fileURLToPath(new URL("../../src/client/use-webui-voice.ts", import.meta.url)),
      "utf8",
    );
    expect(hook).toContain("if (!voiceTouchedRef.current || state.draft === draft) return;");
  });

  /* The two ends of that switch. Turning voice on is a write from the settings
   * page; the mic showing up is a read in a composer that mounted long before.
   * Nothing re-runs that composer's mount effect when the settings page
   * changes, so the two ends only agree if the page writes through the
   * notifying writer AND the composer subscribes. Either half on its own leaves
   * the user with a switch reading "on" over a composer with no mic — which is
   * precisely the bug this row shipped the first time round.
   *
   * Source assertions, for the reason the rest of this block is: the
   * subscription lives in a hook effect, the webui suite runs in
   * `environment: "node"` with no jsdom or test renderer, and
   * `renderToStaticMarkup` does not run effects. The behaviour of both halves
   * is proved above; what is left is the join between them. */
  it("has the composer subscribe inside the effect that reads the setting", () => {
    const hook = readFileSync(
      fileURLToPath(new URL("../../src/client/use-webui-voice.ts", import.meta.url)),
      "utf8",
    );
    const start = hook.indexOf("setSettings(parseWebuiVoiceSettings(localStorage.getItem(");
    expect(start, "the composer no longer reads the stored setting on mount").toBeGreaterThanOrEqual(0);
    const end = hook.indexOf("}, []);", start);
    expect(end, "the mount effect no longer closes on an empty dependency array").toBeGreaterThan(start);
    // Returned, not merely called. The returned cleanup is what React runs on
    // unmount, and without it every later write pokes a component long gone.
    expect(hook.slice(start, end)).toContain("return subscribeWebuiVoiceSettings(setSettings);");
  });

  it("has the settings page write through the notifying writer", () => {
    const start = source.indexOf("const write = useCallback((next: WebuiVoiceSettingsValue) => {");
    expect(start, "the voice settings page's write callback moved").toBeGreaterThanOrEqual(0);
    const end = source.indexOf("}, []);", start);
    expect(end, "the voice settings page's write callback no longer closes on an empty dependency array").toBeGreaterThan(start);
    const body = source.slice(start, end);
    expect(body).toContain("writeWebuiVoiceSettings(next)");
    // A bare setItem persists the value and tells nobody. That is the bug
    // itself, not a near miss of it: the switch looks right and the mic stays
    // missing until a reload.
    expect(body).not.toContain("localStorage.setItem");
  });
});

describe("the voice settings page", () => {
  const render = (props: Record<string, unknown> = {}): string =>
    renderToStaticMarkup(
      createElement(WebuiVoiceSettings, { settings: { enabled: false, language: "zh-CN" }, support: "supported", ...props } as never),
    );

  it("says plainly when the browser cannot listen", () => {
    const markup = render({ support: "unsupported" });
    expect(markup).toContain('data-testid="voice-unsupported"');
    /* A banner that does not say what to do about it is noise. */
    expect(markup).toContain("Chrome");
  });

  it("offers the recogniser languages as a choice", () => {
    const markup = render();
    for (const entry of WEBUI_VOICE_LANGUAGES) {
      expect(markup).toContain(entry.tag);
    }
  });

  it("marks the page so the composer and the test can find it", () => {
    expect(render()).toContain('data-testid="settings-voice-page"');
  });

  it("carries the stored settings key", () => {
    expect(WEBUI_VOICE_SETTINGS_KEY.length).toBeGreaterThan(0);
  });
});
