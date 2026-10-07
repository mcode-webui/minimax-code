/* Roadmap P 区「语音输入」.
 *
 * The Web Speech API is Chromium and partly Safari. Firefox has never shipped
 * it. A mic button that appears and then fails costs the user a click and tells
 * them nothing, so "can this browser listen" is a first-class state here
 * rather than a boolean folded away at the call site.
 *
 * The recogniser revises its own interim text continuously, and the user keeps
 * typing while it does. So the state tracks where this utterance began, and
 * every interim update replaces exactly the segment this utterance contributed
 * — everything before and after it survives untouched. Getting that wrong
 * silently eats whatever the user was in the middle of writing.
 */

export type WebuiVoiceSupport = "unknown" | "supported" | "unsupported";
export type WebuiVoicePhase = "idle" | "listening";

export interface WebuiVoiceState {
  readonly phase: WebuiVoicePhase;
  readonly support: WebuiVoiceSupport;
  /** The composer text, mirrored so the reducer can place the segment. */
  readonly draft: string;
  /** Index in `draft` where this utterance's text begins. */
  readonly segmentStart: number;
  /** What the recogniser has produced so far for this utterance. */
  readonly interim: string;
  readonly error?: string;
}

export type WebuiVoiceAction =
  | { readonly type: "support-resolved"; readonly support: WebuiVoiceSupport }
  | { readonly type: "start"; readonly draft: string; readonly at: number }
  | { readonly type: "interim"; readonly text: string }
  | { readonly type: "final"; readonly text: string }
  | { readonly type: "failed"; readonly reason: string }
  | { readonly type: "cancelled" };

export interface WebuiVoiceSettings {
  readonly enabled: boolean;
  readonly language: string;
}

export interface WebuiVoiceLanguage {
  readonly tag: string;
  readonly label: string;
}

/**
 * A recogniser language the page offers. Kept small and explicit: a free-text
 * tag the browser silently rejects is worse than a list the user can pick from.
 */
export const WEBUI_VOICE_LANGUAGES: readonly WebuiVoiceLanguage[] = [
  { tag: "zh-CN", label: "中文（普通话）" },
  { tag: "zh-TW", label: "中文（台湾）" },
  { tag: "en-US", label: "English (US)" },
  { tag: "en-GB", label: "English (UK)" },
  { tag: "ja-JP", label: "日本語" },
];

export const WEBUI_VOICE_SETTINGS_KEY = "webui-voice-settings";

const DEFAULT_VOICE_SETTINGS: WebuiVoiceSettings = {
  enabled: false,
  language: WEBUI_VOICE_LANGUAGES[0]?.tag ?? "zh-CN",
};

export function initialWebuiVoiceState(): WebuiVoiceState {
  return { phase: "idle", support: "unknown", draft: "", segmentStart: 0, interim: "" };
}

export function resolveWebuiVoiceSupport(scope: unknown): WebuiVoiceSupport {
  const globals = (scope ?? {}) as { SpeechRecognition?: unknown; webkitSpeechRecognition?: unknown };
  return globals.SpeechRecognition ?? globals.webkitSpeechRecognition ? "supported" : "unsupported";
}

/** Replaces the segment this utterance owns, leaving the rest of the draft. */
function spliceSegment(state: WebuiVoiceState, replacement: string): string {
  const head = state.draft.slice(0, state.segmentStart);
  const tail = state.draft.slice(state.segmentStart + state.interim.length);
  return `${head}${replacement}${tail}`;
}

export function reduceWebuiVoiceState(
  state: WebuiVoiceState,
  action: WebuiVoiceAction,
): WebuiVoiceState {
  switch (action.type) {
    case "support-resolved":
      return { ...state, support: action.support };

    case "start": {
      // Starting on a browser that cannot listen would leave the user watching
      // a button that never reacts, so the session never begins.
      if (state.support !== "supported") return state;
      const at = Math.max(0, Math.min(action.at, action.draft.length));
      return {
        ...state,
        phase: "listening",
        draft: action.draft,
        segmentStart: at,
        interim: "",
        error: undefined,
      };
    }

    case "interim": {
      // Results arriving with no session running are a recogniser bug or a
      // late callback after cancel; either way there is no segment to replace.
      if (state.phase !== "listening") return state;
      return { ...state, interim: action.text, draft: spliceSegment(state, action.text) };
    }

    case "final": {
      if (state.phase !== "listening") return state;
      const draft = spliceSegment(state, action.text);
      return { ...state, phase: "idle", draft, interim: "", error: undefined };
    }

    case "failed": {
      if (state.phase !== "listening") return state;
      // Whatever was recognised before the failure stays in the draft. Throwing
      // it away would lose words the user already saw.
      return { ...state, phase: "idle", interim: "", error: action.reason };
    }

    case "cancelled": {
      if (state.phase !== "listening") return state;
      // The user pressed stop. They did not ask for half a word.
      return { ...state, phase: "idle", draft: spliceSegment(state, ""), interim: "", error: undefined };
    }

    default:
      return state;
  }
}

export function parseWebuiVoiceSettings(raw: string | null | undefined): WebuiVoiceSettings {
  if (!raw) return DEFAULT_VOICE_SETTINGS;
  try {
    const value: unknown = JSON.parse(raw);
    if (typeof value !== "object" || value === null) return DEFAULT_VOICE_SETTINGS;
    const candidate = value as Partial<WebuiVoiceSettings>;
    // A partial object is treated as absent rather than merged. Half a setting
    // would otherwise leave the mic permanently on with no language to use.
    if (typeof candidate.enabled !== "boolean" || typeof candidate.language !== "string") {
      return DEFAULT_VOICE_SETTINGS;
    }
    const known = WEBUI_VOICE_LANGUAGES.some((entry) => entry.tag === candidate.language);
    return {
      enabled: candidate.enabled,
      language: known ? candidate.language : DEFAULT_VOICE_SETTINGS.language,
    };
  } catch {
    return DEFAULT_VOICE_SETTINGS;
  }
}
