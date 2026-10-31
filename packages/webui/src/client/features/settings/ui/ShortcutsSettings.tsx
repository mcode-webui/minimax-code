// The shortcuts page: the actions a user can rebind, the key each one is bound
// to, and the control that captures a new one.
//
// The page is the only place a binding is changed. It hands the result up
// rather than writing to browser storage itself, so the owner of the
// preference decides when and where it is persisted — the same arrangement the
// other settings rows use.
//
// The capture owns the keyboard while it is open. A key press that names a
// binding is consumed here instead of reaching the app, because the press is
// the user naming a shortcut, not the user using one. The one key the capture
// does not consume is Escape: that one belongs to the overlay coordinator, and
// the capture is a layer while it is open.

import { Fragment, useEffect, useMemo, useState, type ReactElement } from "react";
import {
  findShortcutConflict,
  parseShortcut,
  shortcutDisplayLabel,
  type ShortcutActionId,
  type ShortcutBindings,
} from "../../../projection/common/shortcuts.js";
import { SettingsDivider, SettingsPage, SettingsRow, SettingsSection } from "../../../ui/settings-layout.js";
import { SettingsButton } from "./settings-atoms.js";
import { shortcutActionTitle, shortcutSettingsRows } from "../projection/settings-shortcuts.js";
import { FeedbackError } from "../../../ui/feedback.js";
import { useDialogLayer } from "../../../ui/overlay-listeners.js";

export interface ShortcutsSettingsProps {
  readonly bindings: ShortcutBindings;
  readonly onChange: (bindings: ShortcutBindings) => void;
  readonly onReset: () => void;
}

export function ShortcutsSettings({ bindings, onChange, onReset }: ShortcutsSettingsProps): ReactElement {
  const [capturing, setCapturing] = useState<ShortcutActionId | undefined>(undefined);
  const [error, setError] = useState("");
  const rows = useMemo(() => shortcutSettingsRows(bindings), [bindings]);

  /**
   * The capture is a layer while it is open (ADR 0028 § Overlay coordination):
   * the Escape that cancels it is answered by the coordinator, so the page
   * keeps no listener of its own for that key. It sits above the settings
   * modal because the capture owns the keyboard while it is open — a press
   * outside it ends the capture rather than the page underneath.
   */
  const captureLayerId = useDialogLayer({
    id: "shortcut-capture",
    order: 20,
    dismissible: true,
    onClose: () => {
      setCapturing(undefined);
      setError("");
    },
    active: capturing !== undefined,
  });

  useEffect(() => {
    if (!capturing) return;
    const onKeyDown = (event: KeyboardEvent): void => {
      // Escape is the coordinator's: the capture answers it as a layer, and a
      // second listener for the same key would be a second implementation of
      // the same contract.
      if (event.key === "Escape") return;
      // Tab keeps its own meaning while the capture is open: it is how the
      // user leaves the control, and a shortcut that swallows it would leave
      // them stuck on the button they are editing.
      if (event.key !== "Tab") event.preventDefault();
      event.stopPropagation();
      const shortcut = parseShortcut(event);
      // A modifier on its own names no combination, so it is not captured.
      if (!shortcut) return;
      const conflict = findShortcutConflict(bindings, capturing, shortcut);
      if (conflict) {
        setError(`「${shortcutDisplayLabel(shortcut)}」已被「${shortcutActionTitle(conflict)}」占用`);
        return;
      }
      onChange({ ...bindings, [capturing]: shortcut });
      setCapturing(undefined);
      setError("");
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [bindings, capturing, onChange]);

  return (
    <SettingsPage testId="settings-shortcuts-page">
      <SettingsSection
        title="快捷键"
        testId="shortcuts-section"
        hint="点击键位后按下新的组合键；Esc 取消。"
        actions={
          <SettingsButton size="compact" testId="mavis-settings-shortcuts-reset" onClick={() => { setError(""); setCapturing(undefined); onReset(); }}>
            恢复默认
          </SettingsButton>
        }
      >
        {error ? <FeedbackError message={error} className="mavis-settings-shortcut-error" testId="mavis-settings-shortcut-error" /> : null}
        {rows.map((row, index) => (
          <Fragment key={row.actionId}>
            {index > 0 ? <SettingsDivider /> : null}
            <SettingsRow title={row.title} description={row.description} testId={`settings-shortcut-row-${row.actionId}`}>
              {row.editable ? (
                <button
                  type="button"
                  className={`mavis-settings-shortcut-key${capturing === row.actionId ? " is-capturing" : ""}`}
                  data-testid={row.testId}
                  data-overlay-layer={capturing === row.actionId ? captureLayerId : undefined}
                  aria-label={`${row.title}的快捷键，当前为${row.label}`}
                  aria-pressed={capturing === row.actionId}
                  onClick={() => { setError(""); setCapturing(row.actionId); }}
                >
                  {capturing === row.actionId ? "按下组合键…" : row.label}
                </button>
              ) : (
                <span className="mavis-settings-shortcut-key is-static" data-testid={row.testId}>
                  {row.note ?? row.label}
                </span>
              )}
            </SettingsRow>
          </Fragment>
        ))}
      </SettingsSection>
    </SettingsPage>
  );
}
