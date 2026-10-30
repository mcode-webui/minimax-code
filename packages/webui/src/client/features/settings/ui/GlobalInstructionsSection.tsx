// The 自定义指令 editor. One of the three co-visible editors `PersonalizationSettings.tsx`
// composes, moved out of that file with its own lifecycle: it reads the profile file, seeds a
// pre-migration browser draft when there is no file to conflict with, and saves through
// `setGlobalInstructions`.
//
// Its section frame comes from the shared settings skeleton in `client/ui/settings-layout.tsx`, not from the
// parent — the parent composes this module, so a child importing back from it would be a cycle.

import { useCallback, useEffect, useMemo, useState, type ReactElement } from "react";

import type { WebuiGlobalInstructionsView } from "../../../../shared/contracts/personalization.js";
import { useWebuiBrowserCapabilities } from "../../../bindings/browser-capabilities.js";
import { SettingsSection } from "../../../ui/settings-layout.js";
import { PERSONALIZATION_SECTION_HINTS, SettingsButton } from "./settings-atoms.js";

const INSTRUCTIONS_PLACEHOLDER = [
  "# Agents 全局设定",
  "",
  "## 技术背景",
  "",
  "| 维度 | 内容 |",
  "| --- | --- |",
  "| 语言 | TypeScript / Rust / Go |",
  "| 偏好 | 清晰简洁，遵循设计模式 |",
  "",
  "留空保存会删除该文件。",
].join("\n");

/**
 * Pre-migration storage key from the pre-AGENTS.md prototype. If it holds
 * text, that text is user-authored and would be lost on upgrade, so it is
 * seeded into the editor once. The flag is written only after a successful
 * server read so a failed load retries the migration instead of burning it.
 */
const LEGACY_STORAGE_KEY = "webui-custom-instructions";
const MIGRATION_FLAG_KEY = "webui-custom-instructions-migrated";

function readLegacyDraft(storage: ReturnType<typeof useWebuiBrowserCapabilities>["storage"]): string {
  return storage.getItem(LEGACY_STORAGE_KEY) ?? "";
}

function markMigrationDone(storage: ReturnType<typeof useWebuiBrowserCapabilities>["storage"]): void {
  storage.setItem(MIGRATION_FLAG_KEY, "1");
  storage.removeItem(LEGACY_STORAGE_KEY);
}

/**
 * What the editor should open with.
 *
 * The live profile file always wins: a non-empty `AGENTS.md` is what the next
 * turn will read, and seeding a stale browser-local draft over it would
 * resurrect text the user has already replaced on disk. The legacy draft is
 * only adopted when there is no file to conflict with, and only once — after
 * that the flag is set and the draft is dropped.
 */
export function resolveEditorSeed(input: {
  readonly exists: boolean;
  readonly content: string;
  readonly legacyDraft: string;
  readonly migrationDone: boolean;
}): string {
  if (input.exists) return input.content;
  if (input.migrationDone) return "";
  return input.legacyDraft.trim() ? input.legacyDraft : "";
}

interface GlobalInstructionsSectionProps {
  readonly getGlobalInstructions?: () => Promise<WebuiGlobalInstructionsView>;
  readonly setGlobalInstructions?: (request: { readonly content: string }) => Promise<WebuiGlobalInstructionsView>;
}

export function GlobalInstructionsSection({
  getGlobalInstructions,
  setGlobalInstructions,
}: GlobalInstructionsSectionProps): ReactElement {
  const { storage } = useWebuiBrowserCapabilities();
  const [draft, setDraft] = useState("");
  const [loaded, setLoaded] = useState<string>();
  const [maxBytes, setMaxBytes] = useState(32 * 1024);
  const [filePath, setFilePath] = useState("");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string>();

  useEffect(() => {
    if (!getGlobalInstructions) return;
    let cancelled = false;
    void getGlobalInstructions()
      .then((value) => {
        if (cancelled || !value) return;
        setLoaded(value.content);
        setMaxBytes(value.maxBytes);
        setFilePath(value.path);
        setDraft(
          resolveEditorSeed({
            exists: value.exists,
            content: value.content,
            legacyDraft: readLegacyDraft(storage),
            migrationDone: storage.getItem(MIGRATION_FLAG_KEY) === "1",
          }),
        );
        // A live profile file retires the legacy draft immediately: the user
        // already has content there, so keeping a browser-local copy around
        // only creates a second source that can drift.
        if (value.exists) markMigrationDone(storage);
      })
      .catch((cause: unknown) => {
        if (cancelled) return;
        setError(cause instanceof Error ? cause.message : String(cause));
      });
    return () => {
      cancelled = true;
    };
  }, [getGlobalInstructions]);

  const byteLength = useMemo(() => new TextEncoder().encode(draft).length, [draft]);
  const overLimit = byteLength > maxBytes;
  const dirty = loaded !== undefined && draft !== loaded;

  const save = useCallback(async () => {
    if (!setGlobalInstructions || saving || overLimit) return;
    setSaving(true);
    setError(undefined);
    try {
      const next = await setGlobalInstructions({ content: draft });
      if (next) {
        setLoaded(next.content);
        setMaxBytes(next.maxBytes);
        setFilePath(next.path);
      }
      markMigrationDone(storage);
      setSaved(true);
    } catch (cause: unknown) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSaving(false);
    }
  }, [draft, overLimit, saving, setGlobalInstructions, storage]);

  return (
    <SettingsSection
      title="自定义指令"
      testId="global-instructions-section"
      hint={PERSONALIZATION_SECTION_HINTS.globalInstructions}
      hintTestId="global-instructions-hint"
      actions={
        <SettingsButton
          variant="black"
          className="webui-section-save-button"
          testId="global-instructions-save"
          disabled={!dirty || saving || overLimit || !setGlobalInstructions}
          onClick={() => void save()}
        >
          保存
        </SettingsButton>
      }
    >
      <textarea
        data-testid="global-instructions-textarea"
        className="webui-personalization-textarea"
        value={draft}
        spellCheck={false}
        placeholder={INSTRUCTIONS_PLACEHOLDER}
        onChange={(event) => {
          setDraft(event.target.value);
          setSaved(false);
        }}
      />
      <div className="webui-personalization-meta">
        <span data-testid="global-instructions-path">{filePath}</span>
        <span
          data-testid="global-instructions-size"
          className={overLimit ? "is-over-limit" : undefined}
        >
          {byteLength} / {maxBytes} 字节
        </span>
      </div>
      {overLimit ? (
        <p role="alert" data-testid="global-instructions-over-limit" className="webui-settings-error">
          内容超出 {maxBytes} 字节上限，请精简后再保存。
        </p>
      ) : null}
      {error ? (
        <p role="alert" data-testid="global-instructions-error" className="webui-settings-error">
          {error}
        </p>
      ) : null}
      {saved && !dirty ? (
        <p data-testid="global-instructions-saved" className="webui-personalization-saved">
          已保存
        </p>
      ) : null}
      {!setGlobalInstructions ? (
        <p data-testid="global-instructions-unavailable" className="webui-settings-error">
          当前运行时不支持自定义指令读写。
        </p>
      ) : null}
    </SettingsSection>
  );
}
