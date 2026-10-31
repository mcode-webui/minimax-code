import { describe, expect, it } from "vitest";
import {
  DEFAULT_SHORTCUT_BINDINGS,
  findShortcutConflict,
  normalizeShortcut,
  parseShortcut,
  parseShortcutBindings,
  serializeShortcutBindings,
  shortcutBaseKey,
  shortcutDisplayLabel,
  shortcutMatches,
  type ShortcutKeyEvent,
} from "../../src/client/projection/common/shortcuts.js";
import {
  SHORTCUT_SETTINGS_ACTIONS,
  shortcutActionTitle,
  shortcutSettingsRows,
} from "../../src/client/features/settings/projection/settings-shortcuts.js";

/** A key press, with only what the notation reads. */
const press = (overrides: Partial<ShortcutKeyEvent> & { readonly key: string }): ShortcutKeyEvent => ({
  code: undefined,
  ctrlKey: false,
  metaKey: false,
  altKey: false,
  shiftKey: false,
  ...overrides,
});

describe("shortcut notation", () => {
  it("names a bare key by the key itself", () => {
    expect(parseShortcut(press({ key: "Enter", code: "Enter" }))).toBe("Enter");
    expect(parseShortcut(press({ key: "F5", code: "F5" }))).toBe("F5");
    expect(parseShortcut(press({ key: " ", code: "Space" }))).toBe("Space");
  });

  it("names a modified key by its modifiers and its base key", () => {
    expect(parseShortcut(press({ key: "Enter", code: "Enter", shiftKey: true }))).toBe("Shift+Enter");
    expect(parseShortcut(press({ key: "Enter", code: "Enter", ctrlKey: true }))).toBe("Control+Enter");
    expect(parseShortcut(press({ key: "Enter", code: "Enter", metaKey: true }))).toBe("Meta+Enter");
    expect(parseShortcut(press({ key: "Enter", code: "Enter", altKey: true }))).toBe("Alt+Enter");
    expect(parseShortcut(press({ key: "Enter", code: "Enter", ctrlKey: true, shiftKey: true }))).toBe("Control+Shift+Enter");
  });

  it("keeps a letter and the same letter with shift apart", () => {
    expect(parseShortcut(press({ key: "a", code: "KeyA" }))).toBe("A");
    expect(parseShortcut(press({ key: "A", code: "KeyA", shiftKey: true }))).toBe("Shift+A");
  });

  it("names no binding for a modifier pressed on its own", () => {
    // A binding is a combination. Capturing `Shift` alone would leave the user
    // with a shortcut that fires whenever they hold a key down.
    expect(parseShortcut(press({ key: "Shift", code: "ShiftLeft", shiftKey: true }))).toBeUndefined();
    expect(parseShortcut(press({ key: "Control", code: "ControlLeft", ctrlKey: true }))).toBeUndefined();
    expect(parseShortcut(press({ key: "Alt", code: "AltLeft", altKey: true }))).toBeUndefined();
    expect(parseShortcut(press({ key: "Meta", code: "MetaLeft", metaKey: true }))).toBeUndefined();
  });

  it("reads a written binding back the way the page and the composer agree on it", () => {
    expect(normalizeShortcut("ctrl+enter")).toBe("Control+Enter");
    expect(normalizeShortcut("Shift + Enter")).toBe("Shift+Enter");
    expect(normalizeShortcut("cmd+enter")).toBe("Meta+Enter");
    expect(normalizeShortcut("Enter")).toBe("Enter");
  });

  it("rejects a written binding that cannot be one", () => {
    expect(normalizeShortcut("")).toBeUndefined();
    expect(normalizeShortcut("Shift")).toBeUndefined();
    expect(normalizeShortcut("Hyper+Enter")).toBeUndefined();
  });
});

describe("shortcut matching", () => {
  it("matches the exact combination and nothing else", () => {
    const enter = press({ key: "Enter", code: "Enter" });
    expect(shortcutMatches("Enter", enter)).toBe(true);
    expect(shortcutMatches("Control+Enter", enter)).toBe(false);
    expect(shortcutMatches("Shift+Enter", press({ key: "Enter", code: "Enter", shiftKey: true }))).toBe(true);
    expect(shortcutMatches("Enter", press({ key: "Enter", code: "Enter", shiftKey: true }))).toBe(false);
  });

  it("matches nothing against a binding that names nothing", () => {
    expect(shortcutMatches("", press({ key: "Enter", code: "Enter" }))).toBe(false);
  });

  it("answers which key a binding is about", () => {
    expect(shortcutBaseKey("Control+Enter")).toBe("Enter");
    expect(shortcutBaseKey("Control+J")).toBe("J");
    expect(shortcutBaseKey("")).toBeUndefined();
  });
});

describe("shortcut conflicts", () => {
  it("reports the action a binding would collide with", () => {
    expect(findShortcutConflict(DEFAULT_SHORTCUT_BINDINGS, "composer.newline", "Enter")).toBe("composer.submit");
    expect(findShortcutConflict(DEFAULT_SHORTCUT_BINDINGS, "composer.submit", "Shift+Enter")).toBe("composer.newline");
  });

  it("does not report a collision with the action's own binding", () => {
    expect(findShortcutConflict(DEFAULT_SHORTCUT_BINDINGS, "composer.submit", "Enter")).toBeUndefined();
  });

  it("does not report a collision with a combination nothing is bound to", () => {
    expect(findShortcutConflict(DEFAULT_SHORTCUT_BINDINGS, "composer.submit", "Control+Enter")).toBeUndefined();
  });

  it("does not report a collision for a binding that cannot be one", () => {
    expect(findShortcutConflict(DEFAULT_SHORTCUT_BINDINGS, "composer.submit", "Shift")).toBeUndefined();
  });
});

describe("stored shortcut bindings", () => {
  it("reads the built-in bindings when nothing is stored", () => {
    expect(parseShortcutBindings(null)).toEqual(DEFAULT_SHORTCUT_BINDINGS);
    expect(parseShortcutBindings(undefined)).toEqual(DEFAULT_SHORTCUT_BINDINGS);
  });

  it("falls back to the built-in bindings when the stored value cannot be read", () => {
    expect(parseShortcutBindings("not json")).toEqual(DEFAULT_SHORTCUT_BINDINGS);
    expect(parseShortcutBindings("[]")).toEqual(DEFAULT_SHORTCUT_BINDINGS);
    expect(parseShortcutBindings('"a string"')).toEqual(DEFAULT_SHORTCUT_BINDINGS);
  });

  it("keeps the default of an action whose stored binding cannot be one", () => {
    // A corrupt preference must not leave the composer without a way to send.
    expect(parseShortcutBindings('{"composer.submit":"Shift"}')).toEqual(DEFAULT_SHORTCUT_BINDINGS);
    expect(parseShortcutBindings('{"composer.submit":42}')).toEqual(DEFAULT_SHORTCUT_BINDINGS);
  });

  it("reads the stored binding of an action and leaves the others alone", () => {
    expect(parseShortcutBindings('{"composer.submit":"Control+Enter"}')).toEqual({
      "composer.submit": "Control+Enter",
      "composer.newline": "Shift+Enter",
      "composer.stop": "",
    });
  });

  it("ignores an action it does not know", () => {
    expect(parseShortcutBindings('{"composer.teleport":"Control+Enter"}')).toEqual(DEFAULT_SHORTCUT_BINDINGS);
  });

  it("writes the bindings back in their canonical form", () => {
    expect(serializeShortcutBindings({ ...DEFAULT_SHORTCUT_BINDINGS, "composer.submit": "ctrl+enter" })).toBe(
      '{"composer.submit":"Control+Enter","composer.newline":"Shift+Enter","composer.stop":""}',
    );
    expect(parseShortcutBindings(serializeShortcutBindings(DEFAULT_SHORTCUT_BINDINGS))).toEqual(DEFAULT_SHORTCUT_BINDINGS);
  });
});

describe("how a binding is shown", () => {
  it("spells the modifiers the way the platform names them", () => {
    expect(shortcutDisplayLabel("Enter")).toBe("Enter");
    expect(shortcutDisplayLabel("Control+Enter")).toBe("Ctrl + Enter");
    expect(shortcutDisplayLabel("Shift+Enter")).toBe("Shift + Enter");
    expect(shortcutDisplayLabel("Meta+Enter")).toBe("Cmd + Enter");
    expect(shortcutDisplayLabel("Alt+Enter")).toBe("Alt + Enter");
  });

  it("says so when a binding names nothing", () => {
    expect(shortcutDisplayLabel("")).toBe("未设置");
  });
});

describe("the shortcuts page rows", () => {
  it("lists the two composer actions and the action that has no binding", () => {
    const rows = shortcutSettingsRows(DEFAULT_SHORTCUT_BINDINGS);
    expect(rows.map((row) => row.actionId)).toEqual(["composer.submit", "composer.newline", "composer.stop"]);
    expect(rows.map((row) => row.title)).toEqual(["发送消息", "换行", "停止生成"]);
    expect(rows.map((row) => row.editable)).toEqual([true, true, false]);
  });

  it("shows the current binding of each action", () => {
    const rows = shortcutSettingsRows({ ...DEFAULT_SHORTCUT_BINDINGS, "composer.submit": "Control+Enter" });
    expect(rows[0]?.label).toBe("Ctrl + Enter");
    expect(rows[1]?.label).toBe("Shift + Enter");
    expect(rows[2]?.label).toBe("未设置");
  });

  it("says that stopping a generation is a button and nothing else", () => {
    // `Escape` is already spoken for by the menus it closes, so the row says so
    // rather than offering a binding that would fight them.
    expect(SHORTCUT_SETTINGS_ACTIONS[2]?.note).toBe("仅按钮，无快捷键");
  });

  it("names the action a collided binding belongs to", () => {
    expect(shortcutActionTitle("composer.submit")).toBe("发送消息");
    expect(shortcutActionTitle("composer.newline")).toBe("换行");
  });
});
