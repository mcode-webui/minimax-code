import { useCallback, useEffect, useMemo, useState, type ReactElement } from "react";
import type { WebuiGlobalInstructionsView } from "../../../server/port.js";
import type { WebuiAgentMemoryView } from "../../contracts.js";

/**
 * Personalization panel — the profile-wide `AGENTS.md` editor.
 *
 * Scope note for reviewers: this lands in the same settings modal that the P
 * area (设置中心) also touches, but the two do not overlap in behaviour. P owns
 * the shell — tab list, groups, search filtering. This component owns one tab
 * body and the two transport calls behind it. The only shared line is the
 * `disabled` flag on the `custom-instructions` tab definition in
 * `SettingsModal.tsx`, which this PR removes.
 */

const PLACEHOLDER = [
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

export interface PersonalizationSettingsProps {
  readonly getGlobalInstructions?: () => Promise<WebuiGlobalInstructionsView>;
  readonly setGlobalInstructions?: (request: {
    readonly content: string;
  }) => Promise<WebuiGlobalInstructionsView>;
  readonly getAgentMemory?: (request?: {
    readonly includeContent?: boolean;
  }) => Promise<WebuiAgentMemoryView>;
  readonly setAgentMemory?: (request: {
    readonly content: string;
  }) => Promise<WebuiAgentMemoryView>;
}

/**
 * Pre-migration storage key from the pre-AGENTS.md prototype. If it holds
 * text, that text is user-authored and would be lost on upgrade, so it is
 * seeded into the editor once. The flag is written only after a successful
 * server read so a failed load retries the migration instead of burning it.
 */
const LEGACY_STORAGE_KEY = "webui-custom-instructions";
const MIGRATION_FLAG_KEY = "webui-custom-instructions-migrated";

function readLegacyDraft(): string {
  if (typeof localStorage === "undefined") return "";
  return localStorage.getItem(LEGACY_STORAGE_KEY) ?? "";
}

function markMigrationDone(): void {
  if (typeof localStorage === "undefined") return;
  localStorage.setItem(MIGRATION_FLAG_KEY, "1");
  localStorage.removeItem(LEGACY_STORAGE_KEY);
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

export function PersonalizationSettings({
  getGlobalInstructions,
  setGlobalInstructions,
  getAgentMemory,
  setAgentMemory,
}: PersonalizationSettingsProps): ReactElement {
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
            legacyDraft: readLegacyDraft(),
            migrationDone: localStorage?.getItem(MIGRATION_FLAG_KEY) === "1",
          }),
        );
        // A live profile file retires the legacy draft immediately: the user
        // already has content there, so keeping a browser-local copy around
        // only creates a second source that can drift.
        if (value.exists) markMigrationDone();
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
      markMigrationDone();
      setSaved(true);
    } catch (cause: unknown) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSaving(false);
    }
  }, [draft, overLimit, saving, setGlobalInstructions]);

  return (
    <div data-testid="content-body" className="webui-personalization-page">
      <section
        data-testid="global-instructions-section"
        className="webui-generic-section"
      >
        <div className="webui-personalization-header">
          <h3>自定义指令</h3>
          <button
            type="button"
            data-testid="global-instructions-save"
            className="webui-mavis-button webui-mavis-button-gray"
            disabled={!dirty || saving || overLimit || !setGlobalInstructions}
            onClick={() => void save()}
          >
            保存
          </button>
        </div>
        <div className="webui-generic-card">
          <textarea
            data-testid="global-instructions-textarea"
            className="webui-personalization-textarea"
            value={draft}
            spellCheck={false}
            placeholder={PLACEHOLDER}
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
        </div>
      </section>
      <AgentMemorySection
        getAgentMemory={getAgentMemory}
        setAgentMemory={setAgentMemory}
      />
    </div>
  );
}

export interface AgentMemorySectionProps {
  readonly getAgentMemory?: (request?: {
    readonly includeContent?: boolean;
  }) => Promise<WebuiAgentMemoryView>;
  readonly setAgentMemory?: (request: {
    readonly content: string;
  }) => Promise<WebuiAgentMemoryView>;
}

/**
 * 长期记忆 — the per-agent main memory file.
 *
 * Summary first, body on request. A live main file runs past the runtime's
 * 64KB cleanup threshold (the profile this was built against held 110KB), so
 * the section renders the size and mtime from a bodyless read and only fetches
 * the text when the user asks to edit it. Rendering the whole file into a
 * textarea up front would make the settings tab pay for a large payload and a
 * large DOM on every open to display a row of metadata.
 *
 * This is main memory, not `writeMemorySummary` — the runtime rejects summary
 * content over 4KB, and the desktop's 记忆概要 modal shows a 68KB document, so
 * the two cannot be the same store.
 */
export function AgentMemorySection({
  getAgentMemory,
  setAgentMemory,
}: AgentMemorySectionProps): ReactElement {
  const [summary, setSummary] = useState<WebuiAgentMemoryView>();
  const [draft, setDraft] = useState<string>();
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string>();

  useEffect(() => {
    if (!getAgentMemory) return;
    let cancelled = false;
    void getAgentMemory()
      .then((value) => {
        if (cancelled || !value) return;
        setSummary(value);
      })
      .catch((cause: unknown) => {
        if (cancelled) return;
        setError(cause instanceof Error ? cause.message : String(cause));
      });
    return () => {
      cancelled = true;
    };
  }, [getAgentMemory]);

  const load = useCallback(async () => {
    if (!getAgentMemory || loading) return;
    setLoading(true);
    setError(undefined);
    try {
      const value = await getAgentMemory({ includeContent: true });
      if (value) {
        setSummary(value);
        setDraft(value.content ?? "");
      }
    } catch (cause: unknown) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoading(false);
    }
  }, [getAgentMemory, loading]);

  const save = useCallback(async () => {
    if (!setAgentMemory || saving || draft === undefined) return;
    setSaving(true);
    setError(undefined);
    try {
      const next = await setAgentMemory({ content: draft });
      if (next) setSummary(next);
      setSaved(true);
    } catch (cause: unknown) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSaving(false);
    }
  }, [draft, saving, setAgentMemory]);

  const editing = draft !== undefined;

  return (
    <section
      data-testid="agent-memory-section"
      className="webui-generic-section"
    >
      <div className="webui-personalization-header">
        <h3>长期记忆</h3>
        {editing ? (
          <button
            type="button"
            data-testid="agent-memory-save"
            className="webui-mavis-button webui-mavis-button-gray"
            disabled={saving || !setAgentMemory}
            onClick={() => void save()}
          >
            保存
          </button>
        ) : (
          <button
            type="button"
            data-testid="agent-memory-load"
            className="webui-mavis-button webui-mavis-button-gray"
            disabled={loading || !getAgentMemory}
            onClick={() => void load()}
          >
            {loading ? "加载中…" : "加载并编辑"}
          </button>
        )}
      </div>
      <div className="webui-generic-card">
        {editing ? (
          <textarea
            data-testid="agent-memory-textarea"
            className="webui-personalization-textarea"
            value={draft}
            spellCheck={false}
            onChange={(event) => {
              setDraft(event.target.value);
              setSaved(false);
            }}
          />
        ) : (
          <p data-testid="agent-memory-summary" className="webui-personalization-meta">
            {summary?.exists
              ? `${summary.sizeBytes} 字节 · ${summary.path}`
              : "暂无长期记忆文件"}
          </p>
        )}
        {error ? (
          <p role="alert" data-testid="agent-memory-error" className="webui-settings-error">
            {error}
          </p>
        ) : null}
        {saved && !saving ? (
          <p data-testid="agent-memory-saved" className="webui-personalization-saved">
            已保存
          </p>
        ) : null}
        {!getAgentMemory || !setAgentMemory ? (
          <p data-testid="agent-memory-unavailable" className="webui-settings-error">
            当前运行时不支持长期记忆读写。
          </p>
        ) : null}
      </div>
    </section>
  );
}
