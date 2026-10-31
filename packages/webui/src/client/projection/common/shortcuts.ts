// Keyboard shortcut bindings: the notation, the matching and the conflicts.
//
// The settings page owns the page and the composer owns the key handling, but
// both have to agree on what a binding *is*: which key combination names
// which action, whether a captured combination is usable at all, and which
// combinations are already taken. That agreement is a value rather than a
// behaviour of either side, so it lives here, in the one layer both may read.
//
// The notation is one canonical string — modifiers in a fixed order, then the
// base key (`Control+Shift+Enter`). The same string is what the browser
// stores, what the page displays and what the composer matches against, so a
// binding cannot mean one thing on the page and another in the composer.

/** The actions a shortcut can be bound to. */
export type ShortcutActionId = "composer.submit" | "composer.newline" | "composer.stop";

/** The actions, in the order the settings page lists them. */
export const SHORTCUT_ACTION_IDS: readonly ShortcutActionId[] = [
  "composer.submit",
  "composer.newline",
  "composer.stop",
];

/**
 * The part of a keyboard event a binding is read from.
 *
 * It is the shape both a DOM `KeyboardEvent` and a test's literal already
 * have, so nothing here needs a DOM to be exercised.
 */
export interface ShortcutKeyEvent {
  readonly key: string;
  /** The physical key. It is what keeps `A` and `Shift+A` apart. */
  readonly code?: string;
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
  readonly altKey: boolean;
  readonly shiftKey: boolean;
}

/** What every action is bound to. */
export type ShortcutBindings = Readonly<Record<ShortcutActionId, string>>;

/** Where the bindings live in browser storage. */
export const SHORTCUT_STORAGE_KEY = "webui-shortcuts.v1";

/**
 * The built-in bindings: Enter sends the message, Shift+Enter breaks the line.
 *
 * They are the behaviour the composer had before the settings page could
 * change it, expressed as the same values the page shows.
 */
export const DEFAULT_SHORTCUT_BINDINGS: ShortcutBindings = Object.freeze({
  "composer.submit": "Enter",
  "composer.newline": "Shift+Enter",
  "composer.stop": "",
});

type ShortcutModifier = "Control" | "Alt" | "Shift" | "Meta";

/** The order modifiers are written in, so two equal bindings are equal strings. */
const MODIFIER_ORDER: readonly ShortcutModifier[] = ["Control", "Alt", "Shift", "Meta"];

/** How a modifier is spelled when it is read rather than written. */
const MODIFIER_ALIASES: Readonly<Record<string, ShortcutModifier>> = {
  ctrl: "Control",
  control: "Control",
  alt: "Alt",
  option: "Alt",
  shift: "Shift",
  meta: "Meta",
  cmd: "Meta",
  command: "Meta",
  super: "Meta",
  win: "Meta",
};

/** How a modifier is spelled when it is shown. */
const DISPLAY_MODIFIERS: Readonly<Record<ShortcutModifier, string>> = {
  Control: "Ctrl",
  Alt: "Alt",
  Shift: "Shift",
  Meta: "Cmd",
};

/** Keys that are only ever a modifier, and so can never be a binding on their own. */
const MODIFIER_KEYS: ReadonlySet<string> = new Set([
  "Control",
  "Alt",
  "Shift",
  "Meta",
  "AltGraph",
  "CapsLock",
  "NumLock",
  "ScrollLock",
  "Fn",
  "FnLock",
  "Hyper",
  "Super",
  "Symbol",
  "SymbolLock",
  "OS",
]);

/** The named keys, written the way the browser spells them. */
const NAMED_KEYS: Readonly<Record<string, string>> = {
  enter: "Enter",
  escape: "Escape",
  esc: "Escape",
  tab: "Tab",
  backspace: "Backspace",
  delete: "Delete",
  space: "Space",
  " ": "Space",
  arrowup: "ArrowUp",
  arrowdown: "ArrowDown",
  arrowleft: "ArrowLeft",
  arrowright: "ArrowRight",
  home: "Home",
  end: "End",
  pageup: "PageUp",
  pagedown: "PageDown",
  insert: "Insert",
};

/** The canonical spelling of a base key, or undefined when it cannot be one. */
function normalizeBaseKey(raw: string): string | undefined {
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  if (MODIFIER_KEYS.has(trimmed)) return undefined;
  const lower = trimmed.toLowerCase();
  const named = NAMED_KEYS[lower];
  if (named) return named;
  if (/^f\d{1,2}$/u.test(lower)) return lower.toUpperCase();
  if (trimmed.length === 1) return trimmed.toUpperCase();
  return trimmed;
}

function canonicalShortcut(modifiers: ReadonlySet<ShortcutModifier>, base: string): string {
  const parts: string[] = [];
  for (const modifier of MODIFIER_ORDER) if (modifiers.has(modifier)) parts.push(modifier);
  parts.push(base);
  return parts.join("+");
}

/**
 * The canonical form of a written binding, or undefined when it is not one.
 *
 * It accepts what a person would write (`ctrl+enter`, `Shift + Enter`) and
 * returns what the page and the composer agree on (`Control+Enter`).
 */
export function normalizeShortcut(shortcut: string): string | undefined {
  const parts = shortcut.split("+").map((part) => part.trim()).filter((part) => part.length > 0);
  if (parts.length === 0) return undefined;
  const base = normalizeBaseKey(parts[parts.length - 1] ?? "");
  if (!base) return undefined;
  const modifiers = new Set<ShortcutModifier>();
  for (const modifier of parts.slice(0, -1)) {
    const canonical = MODIFIER_ALIASES[modifier.toLowerCase()];
    if (!canonical) return undefined;
    modifiers.add(canonical);
  }
  return canonicalShortcut(modifiers, base);
}

/** The base key of a binding: `Control+Enter` and `Enter` both answer `Enter`. */
export function shortcutBaseKey(shortcut: string): string | undefined {
  const normalized = normalizeShortcut(shortcut);
  if (!normalized) return undefined;
  return normalized.slice(normalized.lastIndexOf("+") + 1);
}

/** The base key of a key press, or undefined when the press carries none. */
function baseKeyOf(event: ShortcutKeyEvent): string | undefined {
  const code = event.code ?? "";
  const letter = /^Key([A-Z])$/u.exec(code);
  if (letter) return letter[1] ?? undefined;
  const digit = /^Digit([0-9])$/u.exec(code);
  if (digit) return digit[1] ?? undefined;
  if (code === "Space") return "Space";
  return normalizeBaseKey(event.key);
}

/**
 * The binding a key press names, or undefined when it names none.
 *
 * A press of a modifier on its own names nothing: a binding is a combination,
 * and capturing `Shift` alone would leave the user with a shortcut that fires
 * whenever they hold a key down.
 */
export function parseShortcut(event: ShortcutKeyEvent): string | undefined {
  const base = baseKeyOf(event);
  if (!base) return undefined;
  const modifiers = new Set<ShortcutModifier>();
  if (event.ctrlKey) modifiers.add("Control");
  if (event.altKey) modifiers.add("Alt");
  if (event.shiftKey) modifiers.add("Shift");
  if (event.metaKey) modifiers.add("Meta");
  return canonicalShortcut(modifiers, base);
}

/** Whether a key press is the one a binding names. */
export function shortcutMatches(shortcut: string, event: ShortcutKeyEvent): boolean {
  const normalized = normalizeShortcut(shortcut);
  if (!normalized) return false;
  return normalized === parseShortcut(event);
}

/**
 * The action a binding would collide with, if any.
 *
 * The action's own current binding is not a collision — rebinding an action to
 * what it already has changes nothing.
 */
export function findShortcutConflict(
  bindings: ShortcutBindings,
  actionId: ShortcutActionId,
  shortcut: string,
): ShortcutActionId | undefined {
  const target = normalizeShortcut(shortcut);
  if (!target) return undefined;
  for (const candidate of SHORTCUT_ACTION_IDS) {
    if (candidate === actionId) continue;
    const value = normalizeShortcut(bindings[candidate]);
    if (value && value === target) return candidate;
  }
  return undefined;
}

/**
 * The bindings a stored value describes.
 *
 * A value that cannot be read, or a binding that cannot be one, falls back to
 * the default for that action: a corrupt preference must not leave the
 * composer without a way to send a message.
 */
export function parseShortcutBindings(raw: string | null | undefined): ShortcutBindings {
  if (!raw) return DEFAULT_SHORTCUT_BINDINGS;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return DEFAULT_SHORTCUT_BINDINGS;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return DEFAULT_SHORTCUT_BINDINGS;
  const source = parsed as Record<string, unknown>;
  const next: Record<ShortcutActionId, string> = { ...DEFAULT_SHORTCUT_BINDINGS };
  for (const action of SHORTCUT_ACTION_IDS) {
    const value = source[action];
    if (typeof value !== "string") continue;
    const normalized = normalizeShortcut(value);
    if (normalized) next[action] = normalized;
  }
  return next;
}

/** The stored form of a set of bindings. */
export function serializeShortcutBindings(bindings: ShortcutBindings): string {
  const next: Record<string, string> = {};
  for (const action of SHORTCUT_ACTION_IDS)
    next[action] = normalizeShortcut(bindings[action]) ?? DEFAULT_SHORTCUT_BINDINGS[action];
  return JSON.stringify(next);
}

/** How a binding is shown on the page. */
export function shortcutDisplayLabel(shortcut: string): string {
  const normalized = normalizeShortcut(shortcut);
  if (!normalized) return "未设置";
  const parts = normalized.split("+");
  const base = parts.pop() ?? "";
  const modifiers = parts.map((part) => DISPLAY_MODIFIERS[part as ShortcutModifier] ?? part);
  return [...modifiers, base].join(" + ");
}
