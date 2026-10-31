// The shortcuts page's own model: which actions it lists, what each one is
// called and which of them can be bound at all.
//
// The page renders this and the composer reads the bindings themselves, so the
// names live here rather than in the component that draws the rows.

import {
  shortcutDisplayLabel,
  type ShortcutActionId,
  type ShortcutBindings,
} from "../../../projection/common/shortcuts.js";

export interface ShortcutSettingsAction {
  readonly actionId: ShortcutActionId;
  /** The control's test id. It is a page detail, not a domain name. */
  readonly testId: string;
  readonly title: string;
  readonly description: string;
  /** Whether the row accepts a new binding. */
  readonly editable: boolean;
  /** What the row says for an action that has no key binding at all. */
  readonly note?: string;
}

/**
 * The actions the page lists.
 *
 * Only the two composer actions that already have keyboard meaning are
 * bindable. Stopping a generation is a button and nothing else: `Escape` is
 * already spoken for by the menus it closes, so the row says so rather than
 * offering a binding that would fight them.
 */
export const SHORTCUT_SETTINGS_ACTIONS: readonly ShortcutSettingsAction[] = [
  {
    actionId: "composer.submit",
    testId: "mavis-settings-shortcut-submit",
    title: "发送消息",
    description: "在输入框中发送当前消息",
    editable: true,
  },
  {
    actionId: "composer.newline",
    testId: "mavis-settings-shortcut-newline",
    title: "换行",
    description: "在输入框中换行，不发送消息",
    editable: true,
  },
  {
    actionId: "composer.stop",
    testId: "mavis-settings-shortcut-stop",
    title: "停止生成",
    description: "仅按钮，无快捷键",
    editable: false,
    note: "仅按钮，无快捷键",
  },
];

export interface ShortcutSettingsRow extends ShortcutSettingsAction {
  /** The action's current binding, in its canonical form. */
  readonly shortcut: string;
  /** How the current binding is shown. */
  readonly label: string;
}

/** The page's rows, for a set of bindings. */
export function shortcutSettingsRows(bindings: ShortcutBindings): readonly ShortcutSettingsRow[] {
  return SHORTCUT_SETTINGS_ACTIONS.map((action) => {
    const shortcut = bindings[action.actionId] ?? "";
    return {
      ...action,
      shortcut,
      label: shortcut ? shortcutDisplayLabel(shortcut) : "未设置",
    };
  });
}

/** The name of an action, for a message that names the action it collided with. */
export function shortcutActionTitle(actionId: ShortcutActionId): string {
  return SHORTCUT_SETTINGS_ACTIONS.find((action) => action.actionId === actionId)?.title ?? actionId;
}
