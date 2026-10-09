/* Roadmap P 区「快捷键管理」.
 *
 * There was no shortcut system to manage before this. The settings row in the
 * user menu is labelled `Ctrl+,`, and no keydown listener in the client ever
 * honoured it — the three document-level listeners that do exist belong to the
 * context menu, the goal banner and the user-menu popover, and each handles
 * only Escape while its own popover is open.
 *
 * Bindings are stored platform-neutrally with `Ctrl` as the primary modifier,
 * and translated for display on macOS. Storing a display string instead would
 * mean a binding written on a Mac does not parse on Windows and vice versa.
 *
 * Only commands that exist are registered. Escape and the arrow keys are
 * deliberately absent: they are how every popover closes and every list
 * navigates, and a user-rebindable Escape breaks the whole shell. The registry
 * asserts that in its own tests.
 */

export interface WebuiShortcutBinding {
  readonly ctrl: boolean;
  readonly meta: boolean;
  readonly alt: boolean;
  readonly shift: boolean;
  /** Lower-cased for letters, verbatim for punctuation and named keys. */
  readonly key: string;
}

/** The subset of KeyboardEvent this module reads. */
export interface WebuiShortcutKeyEvent {
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
  readonly altKey: boolean;
  readonly shiftKey: boolean;
  readonly key: string;
}

export interface WebuiShortcutCommand {
  readonly id: string;
  readonly label: string;
  readonly group: string;
  readonly defaultBinding: string;
}

export interface WebuiShortcutOverride {
  readonly id: string;
  readonly binding: string;
}

/**
 * Every command here is dispatched by the global key handler in
 * `WebuiClientFoundationApp`. A command with no handler behind it would render
 * in the settings page and do nothing — which is the defect this whole change
 * exists to remove.
 */
export const WEBUI_SHORTCUT_COMMANDS: readonly WebuiShortcutCommand[] = [
  { id: "openSettings", label: "打开设置", group: "应用", defaultBinding: "Ctrl+," },
  { id: "toggleSidebar", label: "显示或隐藏侧栏", group: "应用", defaultBinding: "Ctrl+B" },
  { id: "focusComposer", label: "聚焦输入框", group: "会话", defaultBinding: "Ctrl+L" },
];

const MODIFIER_ALIASES: ReadonlyMap<string, "ctrl" | "meta" | "alt" | "shift"> = new Map([
  ["ctrl", "ctrl"],
  ["control", "ctrl"],
  ["⌃", "ctrl"],
  ["meta", "meta"],
  ["cmd", "meta"],
  ["command", "meta"],
  ["⌘", "meta"],
  ["alt", "alt"],
  ["option", "alt"],
  ["⌥", "alt"],
  ["shift", "shift"],
  ["⇧", "shift"],
]);

/**
 * On a US layout the browser reports the shifted glyph for a shifted
 * punctuation key: `Ctrl+Shift+,` arrives as `<`. Both spellings have to match
 * the stored `,` or the binding silently stops firing as soon as Shift is held.
 */
const SHIFTED_GLYPHS: ReadonlyMap<string, string> = new Map([
  ["<", ","],
  [">", "."],
  ["?", "/"],
  [":", ";"],
  ['"', "'"],
  ["{", "["],
  ["}", "]"],
  ["|", "\\"],
  ["_", "-"],
  ["+", "="],
  ["~", "`"],
]);

export function parseWebuiShortcut(binding: string): WebuiShortcutBinding | undefined {
  const parts = binding.split("+").map((part) => part.trim()).filter(Boolean);
  if (parts.length === 0) return undefined;

  const parsed = { ctrl: false, meta: false, alt: false, shift: false, key: "" };
  for (const part of parts) {
    const modifier = MODIFIER_ALIASES.get(part.toLowerCase());
    if (modifier) {
      parsed[modifier] = true;
      continue;
    }
    // Two non-modifier tokens means something like `Ctrl+A+B`, which is not a
    // shortcut anyone can press.
    if (parsed.key.length > 0) return undefined;
    parsed.key = part.length === 1 ? part.toLowerCase() : part;
  }
  // A modifier with no key would fire on Ctrl+anything.
  if (parsed.key.length === 0) return undefined;
  return parsed;
}

function platformUsesMeta(platform?: string): boolean {
  return platform === "darwin";
}

export function formatWebuiShortcut(binding: string, platform?: string): string {
  const parsed = parseWebuiShortcut(binding);
  if (!parsed) return binding;
  const mac = platformUsesMeta(platform);
  const parts: string[] = [];
  if (parsed.ctrl) parts.push(mac ? "⌘" : "Ctrl");
  if (parsed.alt) parts.push(mac ? "⌥" : "Alt");
  if (parsed.shift) parts.push(mac ? "⇧" : "Shift");
  if (parsed.meta) parts.push(mac ? "⌘" : "Meta");
  parts.push(displayKey(parsed.key, mac));
  return parts.join("+");
}

function displayKey(key: string, mac: boolean): string {
  if (/^[a-z]$/u.test(key)) return key.toUpperCase();
  if (key === "Enter") return mac ? "↩" : "Enter";
  return key;
}

/** Comparison key that ignores how the combination was written or displayed. */
function canonicalWebuiShortcut(binding: string): string | undefined {
  const parsed = parseWebuiShortcut(binding);
  if (!parsed) return undefined;
  return [
    parsed.ctrl ? "ctrl" : "",
    parsed.meta ? "meta" : "",
    parsed.alt ? "alt" : "",
    parsed.shift ? "shift" : "",
    parsed.key,
  ].join("+");
}

export function matchesWebuiShortcut(event: WebuiShortcutKeyEvent, binding: string, platform?: string): boolean {
  const parsed = parseWebuiShortcut(binding);
  if (!parsed) return false;

  // `Ctrl` in a stored binding means the platform's primary modifier: ⌘ on
  // macOS, Ctrl everywhere else. Matching the raw ctrlKey unconditionally would
  // make a Windows-key chord fire a Ctrl binding.
  const ctrlHeld = platformUsesMeta(platform) ? event.metaKey : event.ctrlKey;
  if (parsed.ctrl !== ctrlHeld) return false;
  if (parsed.meta !== event.metaKey) return false;
  if (parsed.alt !== event.altKey) return false;
  if (parsed.shift !== event.shiftKey) return false;

  const reported = event.key.length === 1 ? event.key.toLowerCase() : event.key;
  const unshifted = parsed.shift ? SHIFTED_GLYPHS.get(reported) ?? reported : reported;
  return unshifted === parsed.key;
}

export function resolveWebuiShortcutBindings(
  overrides: readonly WebuiShortcutOverride[],
): ReadonlyMap<string, string> {
  const resolved = new Map<string, string>();
  for (const command of WEBUI_SHORTCUT_COMMANDS) resolved.set(command.id, command.defaultBinding);
  // An override that names no known command, or that cannot be parsed, is
  // dropped rather than allowed to break the registry: this data is read back
  // out of localStorage, which the user can edit by hand.
  for (const override of overrides) {
    if (!resolved.has(override.id)) continue;
    if (!parseWebuiShortcut(override.binding)) continue;
    resolved.set(override.id, override.binding);
  }
  return resolved;
}

export function findWebuiShortcutConflict(
  candidate: string,
  commandId: string,
  bindings: ReadonlyMap<string, string>,
): string | undefined {
  const canonical = canonicalWebuiShortcut(candidate);
  if (!canonical) return undefined;
  for (const [id, binding] of bindings) {
    if (id === commandId) continue;
    if (canonicalWebuiShortcut(binding) === canonical) return id;
  }
  return undefined;
}

export function resetWebuiShortcutOverrides(
  overrides: readonly WebuiShortcutOverride[],
  commandId: string,
): WebuiShortcutOverride[] {
  return overrides.filter((override) => override.id !== commandId);
}

/**
 * Shared by the settings page that writes overrides and the shell's global
 * handler that reads them, so the two cannot drift onto different keys.
 */
export const WEBUI_SHORTCUT_OVERRIDES_KEY = "webui-shortcut-overrides";

export function parseWebuiShortcutOverrides(raw: string | null | undefined): WebuiShortcutOverride[] {
  if (!raw) return [];
  try {
    const value: unknown = JSON.parse(raw);
    if (!Array.isArray(value)) return [];
    return value.filter(
      (entry): entry is WebuiShortcutOverride =>
        typeof entry === "object" &&
        entry !== null &&
        typeof (entry as WebuiShortcutOverride).id === "string" &&
        typeof (entry as WebuiShortcutOverride).binding === "string",
    );
  } catch {
    return [];
  }
}

const MODIFIER_KEY_NAMES: ReadonlySet<string> = new Set(["control", "shift", "alt", "meta", "altgraph"]);
const ESCAPE_KEY = "escape";
const FUNCTION_KEY = /^f([1-9]|1[0-9]|2[0-4])$/u;

/**
 * Builds the binding string for a key the user just pressed while the rebind
 * row is capturing.
 *
 * Three things are deliberately not bindings. A lone modifier is the user still
 * reaching for the combination; Escape is the cancel gesture, and accepting it
 * would make backing out of a rebind impossible; and a bare letter is refused
 * because the capture row is modal — without a modifier it reads as ordinary
 * typing. Function keys are the exception, since they never carry text.
 *
 * What is pressed is recorded literally: `Meta+K` stays `Meta+K` and
 * `Ctrl+K` stays `Ctrl+K`. `matchesWebuiShortcut` is where the platform's
 * primary modifier is decided, so doing it here as well would be a second
 * place for the two to disagree.
 */
export function webuiShortcutFromEvent(event: WebuiShortcutKeyEvent): string | undefined {
  // Only single characters are case-folded. `KeyboardEvent.key` reports `F2`
  // and matching compares named keys verbatim, so folding it to `f2` would
  // store a binding that can never fire. The checks below compare against a
  // folded copy for the same reason: `Escape` is neither length 1 nor spelled
  // lowercase.
  const key = event.key.length === 1 ? event.key.toLowerCase() : event.key;
  const folded = key.toLowerCase();
  if (MODIFIER_KEY_NAMES.has(folded) || folded === ESCAPE_KEY) return undefined;
  if (!event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey && !FUNCTION_KEY.test(folded)) {
    return undefined;
  }
  const binding = [
    event.ctrlKey ? "Ctrl" : "",
    event.metaKey ? "Meta" : "",
    event.altKey ? "Alt" : "",
    event.shiftKey ? "Shift" : "",
    key,
  ]
    .filter(Boolean)
    .join("+");
  // Round-tripping through the parser is what keeps a recorded binding
  // loadable: an unparseable one would be dropped on the next read and the
  // user's choice would silently revert to the default.
  return parseWebuiShortcut(binding) ? binding : undefined;
}
