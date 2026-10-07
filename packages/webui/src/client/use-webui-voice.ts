/* Roadmap P 区「语音输入」.
 *
 * Everything here is lifecycle glue around the Web Speech API and the pure
 * reducer in `voice-state.ts`. The recogniser is a non-standard global, so its
 * shape is declared narrowly rather than pulling in a DOM lib that has it.
 *
 * The rule the whole file exists to enforce: **no recogniser is constructed
 * until the user asks for one.** Chrome's implementation opens a microphone
 * stream as soon as `start()` is called, and constructing the object does not
 * — but constructing it eagerly on mount would still leave a live object
 * around on every page load for a feature most users never turn on.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import {
  WEBUI_VOICE_SETTINGS_KEY,
  initialWebuiVoiceState,
  parseWebuiVoiceSettings,
  reduceWebuiVoiceState,
  resolveWebuiVoiceSupport,
  subscribeWebuiVoiceSettings,
  type WebuiVoiceSettings,
  type WebuiVoiceState,
} from "./projection/voice-state.js";

interface WebuiSpeechRecognitionAlternativeLike {
  readonly transcript: string;
}
interface WebuiSpeechRecognitionResultLike {
  readonly isFinal: boolean;
  readonly length: number;
  [index: number]: WebuiSpeechRecognitionAlternativeLike | undefined;
}
interface WebuiSpeechRecognitionEventLike {
  readonly resultIndex: number;
  readonly results: {
    readonly length: number;
    [index: number]: WebuiSpeechRecognitionResultLike | undefined;
  };
}
interface WebuiSpeechRecognitionLike {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  start(): void;
  stop(): void;
  abort(): void;
  onresult: ((event: WebuiSpeechRecognitionEventLike) => void) | null;
  onerror: ((event: { readonly error?: string }) => void) | null;
  onend: (() => void) | null;
}
type WebuiSpeechRecognitionCtor = new () => WebuiSpeechRecognitionLike;

function speechRecognitionCtor(): WebuiSpeechRecognitionCtor | undefined {
  if (typeof window === "undefined") return undefined;
  const scope = window as unknown as { SpeechRecognition?: WebuiSpeechRecognitionCtor; webkitSpeechRecognition?: WebuiSpeechRecognitionCtor };
  return scope.SpeechRecognition ?? scope.webkitSpeechRecognition;
}

export interface WebuiVoiceControls {
  readonly state: WebuiVoiceState;
  readonly settings: WebuiVoiceSettings;
  /** True only when the feature is on and this browser can actually listen. */
  readonly available: boolean;
  readonly toggle: () => void;
  readonly cancel: () => void;
}

export function useWebuiVoice(options: {
  readonly draft: string;
  readonly setDraft: (next: string) => void;
}): WebuiVoiceControls {
  const { draft, setDraft } = options;
  const [state, setState] = useState<WebuiVoiceState>(initialWebuiVoiceState);
  const [settings, setSettings] = useState<WebuiVoiceSettings>(() => parseWebuiVoiceSettings(null));
  const recognitionRef = useRef<WebuiSpeechRecognitionLike | undefined>(undefined);
  // Set when a session starts, cleared once the reducer's draft has been
  // pushed out. Without it the mirror below compares an untouched
  // `state.draft` of "" against whatever the user has typed and clears the
  // composer on the first keystroke.
  const voiceTouchedRef = useRef(false);

  useEffect(() => {
    setSettings(parseWebuiVoiceSettings(localStorage.getItem(WEBUI_VOICE_SETTINGS_KEY)));
    setState((current) => reduceWebuiVoiceState(current, {
      type: "support-resolved",
      support: speechRecognitionCtor() ? "supported" : "unsupported",
    }));
    // The settings page can flip voice on at any time, including after this
    // component mounted. Reading once left the mic missing until a reload.
    return subscribeWebuiVoiceSettings(setSettings);
  }, []);

  // The reducer decides what the draft becomes; this only pushes that out, and
  // only while a voice session is responsible for the text in it.
  useEffect(() => {
    if (!voiceTouchedRef.current || state.draft === draft) return;
    voiceTouchedRef.current = false;
    setDraft(state.draft);
  }, [state.draft, draft, setDraft]);

  const stop = useCallback((action: "final" | "cancelled" | "failed", payload?: string) => {
    recognitionRef.current?.abort();
    recognitionRef.current = undefined;
    setState((current) => reduceWebuiVoiceState(
      current,
      action === "final"
        ? { type: "final", text: payload ?? current.interim }
        : action === "failed"
          ? { type: "failed", reason: payload ?? "unknown" }
          : { type: "cancelled" },
    ));
  }, []);

  const toggle = useCallback(() => {
    if (state.phase === "listening") {
      stop("final");
      return;
    }
    const Ctor = speechRecognitionCtor();
    if (!Ctor) return;
    const textarea = typeof document === "undefined" ? undefined : document.querySelector<HTMLTextAreaElement>('textarea[name="content"]');
    voiceTouchedRef.current = true;
    setState((current) => reduceWebuiVoiceState(current, {
      type: "start",
      draft,
      at: textarea?.selectionStart ?? draft.length,
    }));

    const recognition = new Ctor();
    recognition.lang = settings.language;
    // Interim results are the point: the user watches the sentence assemble
    // instead of waiting for the recogniser to declare it finished.
    recognition.continuous = false;
    recognition.interimResults = true;
    recognition.onresult = (event) => {
      let interim = "";
      for (let index = event.resultIndex; index < event.results.length; index += 1) {
        const result = event.results[index];
        const text = result?.[0]?.transcript ?? "";
        if (result?.isFinal) {
          stop("final", text);
          return;
        }
        interim += text;
      }
      setState((current) => reduceWebuiVoiceState(current, { type: "interim", text: interim }));
    };
    recognition.onerror = (event) => stop("failed", event.error ?? "unknown");
    recognition.onend = () => {
      if (recognitionRef.current) stop("final");
    };
    recognitionRef.current = recognition;
    recognition.start();
  }, [draft, settings.language, state.phase, stop]);

  const cancel = useCallback(() => stop("cancelled"), [stop]);

  useEffect(() => () => recognitionRef.current?.abort(), []);

  return {
    state,
    settings,
    available: settings.enabled && state.support === "supported",
    toggle,
    cancel,
  };
}
