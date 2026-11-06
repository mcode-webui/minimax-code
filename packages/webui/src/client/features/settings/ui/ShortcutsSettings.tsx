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

import { Fragment, useEffect, useId, useMemo, useState, type ReactElement } from "react";
import { WebuiButton } from "../../../ui/button.js";
import { WebuiFieldError } from "../../../ui/field.js";
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
import { useDialogLayer } from "../../../ui/overlay-listeners.js";

export interface ShortcutsSettingsProps {
  readonly bindings: ShortcutBindings;
  readonly onChange: (bindings: ShortcutBindings) => void;
  readonly onReset: () => void;
}

export function ShortcutsSettings({ bindings, onChange, onReset }: ShortcutsSettingsProps): ReactElement {
  const [capturing, setCapturing] = useState<ShortcutActionId | undefined>(undefined);
  const [error, setError] = useState("");
  const errorId = useId();
  const rows = useMemo(() => shortcutSettingsRows(bindings), [bindings]);

  /**
   * The capture is a layer while it is open (ADR 0028 § Overlay coordination),
   * and it sits above the settings modal because the capture owns the keyboard
   * while it is open — a press outside it ends the capture rather than the page
   * underneath.
   *
   * The layer's `onClose` is what ends a capture the coordinator dismisses; the
   * capture also answers Escape itself, because a higher surface can take that
   * key first and a capture left open on a stale conflict notice is the state
   * nobody can get out of.
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

  /**
   * The notice belongs to the capture that raised it.
   *
   * However the capture ends — the coordinator's Escape, a press elsewhere, a
   * successful capture — the conflict it reported stops being true, so it goes
   * with the capture instead of waiting for another one to clear it.
   */
  useEffect(() => {
    if (capturing === undefined) setError("");
  }, [capturing]);

  useEffect(() => {
    if (!capturing) return;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        // Escape leaves the capture and takes the notice it raised with it.
        event.preventDefault();
        event.stopPropagation();
        setCapturing(undefined);
        setError("");
        return;
      }
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
        {error ? <span data-testid="mavis-settings-shortcut-error"><WebuiFieldError id={errorId} message={error} /></span> : null}
        {rows.map((row, index) => (
          <Fragment key={row.actionId}>
            {index > 0 ? <SettingsDivider /> : null}
            <SettingsRow title={row.title} description={row.description} testId={`settings-shortcut-row-${row.actionId}`}>
              {row.editable ? (
                <WebuiButton
                  variant="plain"
                  size="inline"
                  className={`mavis-settings-shortcut-key${capturing === row.actionId ? " is-capturing" : ""}`}
                  data-testid={row.testId}
                  data-overlay-layer={capturing === row.actionId ? captureLayerId : undefined}
                  aria-label={`${row.title}的快捷键，当前为${row.label}`}
                  aria-pressed={capturing === row.actionId}
                  aria-invalid={capturing === row.actionId && error ? true : undefined}
                  aria-describedby={capturing === row.actionId && error ? errorId : undefined}
                  onClick={() => { setError(""); setCapturing(row.actionId); }}
                  // The capture's own control answers Escape: it holds focus while
                  // the capture is open, so the key reaches it before any surface
                  // above decides what to do with it — and leaving the capture
                  // also drops the conflict notice it raised.
                  onKeyDown={(event) => {
                    if (event.key !== "Escape" || capturing !== row.actionId) return;
                    event.preventDefault();
                    event.stopPropagation();
                    setCapturing(undefined);
                    setError("");
                  }}
                >
                  {capturing === row.actionId ? "按下组合键…" : row.label}
                </WebuiButton>
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
