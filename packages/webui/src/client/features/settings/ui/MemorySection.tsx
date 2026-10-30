// The 记忆 card. The third of the three co-visible editors `PersonalizationSettings.tsx` composes:
// a card of rows — two switches and a 管理 action — rather than a standalone textarea.
//
// It renders the manager dialog (the 管理 row's body) in the same conditional it always used, and it
// imports that dialog's shared pieces rather than the other way round: the section renders the dialog,
// so the dialog must not import the section.

import { useCallback, useEffect, useState, type ReactElement } from "react";
import type { WebuiAgentMemoryView, WebuiMemorySettingsView } from "../../../../shared/contracts/personalization.js";
import { ToggleSwitch } from "../../../ui/ToggleSwitch.js";
import { SettingsRow, SettingsSection } from "../../../ui/settings-layout.js";
import { PERSONALIZATION_SECTION_HINTS, SettingsButton } from "./settings-atoms.js";
import { MemoryManagerDialog } from "./MemoryManagerDialog.js";
import { formatMemoryTimestamp, isMemorySaveable, type MemoryHandoff } from "../contracts/memory-handoff.js";

interface MemorySectionProps {
  readonly getAgentMemory?: (request?: {
    readonly includeContent?: boolean;
  }) => Promise<WebuiAgentMemoryView>;
  readonly setAgentMemory?: (request: {
    readonly content: string;
  }) => Promise<WebuiAgentMemoryView>;
  readonly getMemorySettings?: () => Promise<WebuiMemorySettingsView>;
  readonly setMemorySettings?: (request: {
    readonly enabled?: boolean;
    readonly proactive?: boolean;
  }) => Promise<WebuiMemorySettingsView>;
  readonly onCreateInSession?: (input: MemoryHandoff) => void;
}

/**
 * 记忆 — the two switches plus the entry point to the memory manager.
 *
 * Both switches write through to the shared config, so they are global: this is
 * one settings scope, not a per-session one. That
 * is why the panel reports what it wrote rather than implying a per-session
 * effect, and why `memory.enabled` is the only switch here — it is the master
 * gate the runtime already honours, and the second one is meaningless without
 * it.
 *
 * The manager stays closed until the user asks for it: a live main file runs
 * past the runtime's 64KB cleanup threshold, so the row must not pull the body
 * on every panel open.
 */
export function MemorySection({
  getAgentMemory,
  setAgentMemory,
  getMemorySettings,
  setMemorySettings,
  onCreateInSession,
}: MemorySectionProps): ReactElement {
  const [settings, setSettings] = useState<WebuiMemorySettingsView>();
  const [toggling, setToggling] = useState(false);
  const [managing, setManaging] = useState(false);
  const [error, setError] = useState<string>();

  useEffect(() => {
    if (!getMemorySettings) return;
    let cancelled = false;
    void getMemorySettings()
      .then((value) => {
        if (cancelled || !value) return;
        setSettings(value);
      })
      .catch((cause: unknown) => {
        if (cancelled) return;
        setError(cause instanceof Error ? cause.message : String(cause));
      });
    return () => {
      cancelled = true;
    };
  }, [getMemorySettings]);

  // No read on open. The 记忆摘要 row shows only the title, the
  // description and 管理 — the column that sits between them names the owning
  // product, not the file size. The byte count that used to live there was a
  // second, differently-scaled reading of the same file (the manager shows
  // characters), so dropping it removed the reason this read existed: opening
  // the settings pane no longer fetches the whole memory document just to
  // measure it. The dialog still loads the content when 管理 is pressed.

  const toggle = useCallback(
    async (patch: { readonly enabled?: boolean; readonly proactive?: boolean }) => {
      // A switch with no baseline is not a switch the user can reason about:
      // they cannot see what they are changing, and a write against an unknown
      // state is how a setting gets flipped by accident. This is also why the
      // optimistic value below always rolls back — `previous` may legitimately
      // be undefined, and restoring "unknown" is the honest answer, not
      // leaving the guessed value on screen.
      if (!setMemorySettings || toggling || !settings) return;
      setToggling(true);
      setError(undefined);
      const previous = settings;
      // Optimistic, so the switch does not lag a click by a round trip.
      setSettings({ ...previous, ...patch });
      try {
        const next = await setMemorySettings(patch);
        if (next) setSettings(next);
      } catch (cause: unknown) {
        setSettings(previous);
        setError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        setToggling(false);
      }
    },
    [setMemorySettings, settings, toggling],
  );

  // Stable identity on purpose: the dialog moves focus in on mount and hands it
  // back on unmount, and a callback that changes every render would re-run that
  // effect on every keystroke inside the editor.
  const closeManager = useCallback(() => setManaging(false), []);

  return (
    <SettingsSection
      title="记忆"
      testId="memory-section"
      hint={PERSONALIZATION_SECTION_HINTS.memory}
      hintTestId="memory-hint"
    >
      <SettingsRow
        title="记忆"
        description="在提示、提醒和自动维护中使用已保存的记忆"
        testId="memory-enabled-row"
      >
        <ToggleSwitch
          checked={settings?.enabled ?? false}
          label="记忆"
          testId="memory-enabled-switch"
          disabled={toggling || !settings || !setMemorySettings}
          onChange={(checked) => void toggle({ enabled: checked })}
        />
      </SettingsRow>
      <SettingsRow
        title="主动记忆"
        description="主动识别并通过 Memory 保存值得长期保留的偏好和可复用经验"
        testId="memory-proactive-row"
      >
        <ToggleSwitch
          checked={settings?.proactive ?? false}
          label="主动记忆"
          testId="memory-proactive-switch"
          disabled={toggling || !settings || !setMemorySettings}
          onChange={(checked) => void toggle({ proactive: checked })}
        />
      </SettingsRow>
      <SettingsRow
        title="记忆摘要"
        description="查看、编辑或删除 MiniMax 已整理的长期记忆。"
        testId="memory-summary-row"
      >
        <SettingsButton
          testId="agent-memory-load"
          disabled={!getAgentMemory || !setAgentMemory}
          onClick={() => setManaging((open) => !open)}
        >
          管理
        </SettingsButton>
      </SettingsRow>
      {!getMemorySettings || !setMemorySettings ? (
        <p data-testid="memory-settings-unavailable" className="webui-settings-error">
          当前运行时不支持记忆开关。
        </p>
      ) : null}
      {!getAgentMemory || !setAgentMemory ? (
        <p data-testid="agent-memory-unavailable" className="webui-settings-error">
          当前运行时不支持长期记忆读写。
        </p>
      ) : null}
      {error ? (
        <p role="alert" data-testid="memory-error" className="webui-settings-error">
          {error}
        </p>
      ) : null}
      {managing ? (
        <MemoryManagerDialog
          getAgentMemory={getAgentMemory}
          setAgentMemory={setAgentMemory}
          onClose={closeManager}
          {...(onCreateInSession ? { onCreateInSession } : {})}
        />
      ) : null}
    </SettingsSection>
  );
}