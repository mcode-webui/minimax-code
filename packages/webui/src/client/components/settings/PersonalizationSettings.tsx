import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { ToggleSwitch } from "../ToggleSwitch.js";
import type {
  WebuiAgentMemoryView,
  WebuiGlobalInstructionsView,
  WebuiMemorySettingsView,
  WebuiUserProfileView,
} from "../../contracts.js";

/**
 * Personalization panel — the three blocks the desktop surface ships:
 * 自定义指令, 关于你, 记忆.
 *
 * Shape note for reviewers: the desktop presents 记忆 as a card of three rows
 * (two switches plus a 管理 action that opens the memory manager), not as a
 * single textarea. The earlier revision rendered a standalone 长期记忆 editor;
 * it was the same file and the same operations, just a different surface, and
 * the roadmap's "管理 UI 未见" is only closed by the row that points at a
 * manager.
 *
 * Scope note: this lands in the same settings modal that the P area (设置中心)
 * also touches, but the two do not overlap in behaviour. P owns the shell — tab
 * list, groups, search filtering. This component owns one tab body and the
 * transport calls behind it. The only shared line is the `disabled` flag on the
 * `custom-instructions` tab definition in `SettingsModal.tsx`, which the earlier
 * PR removed.
 */

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

const PROFILE_PLACEHOLDER = "告诉 Agent 你的背景和长期偏好……";

/**
 * The three section bubbles, copied from the desktop word for word.
 *
 * Exported because the test asserts the exact strings: a tooltip is copy the
 * user reads, and a paraphrase that reads fine still means the WebUI and the
 * desktop stop saying the same thing about the same control.
 */
export const PERSONALIZATION_SECTION_HINTS = {
  globalInstructions:
    "定义 Agent 应该如何工作、回答和执行任务，为此设备上的所有 Agent 提供额外指令和上下文。",
  userProfile: "告诉 Agent 你的背景和长期偏好。",
  memory: "设置在此电脑上如何收集、保留和整合本地记忆。",
} as const;

/**
 * The section title's help affordance.
 *
 * A real bubble rather than a native `title`, because the desktop hangs a dark
 * bubble with an arrow above the glyph and a `title` cannot match it: the
 * browser draws its own surface, delays it about a second, and paints no
 * arrow. The shape itself is not new — `.webui-signin-credits-tooltip` and
 * `.webui-context-usage-label` already carry it, and this is the third call
 * site against the same object rather than a third design.
 *
 * Two decisions worth stating. It is a real `button`, not the `role="img"`
 * span it replaces, so the affordance is reachable by keyboard; the bubble is
 * `aria-hidden` because `aria-label` already reads as the control's name and
 * a `role="tooltip"` nothing references would be a second, dangling
 * announcement of the same sentence.
 */
function InfoHint({ text, testId }: { readonly text: string; readonly testId: string }): ReactElement {
  return (
    <span className="webui-settings-info-hint-anchor">
      <button type="button" data-testid={testId} className="webui-settings-info-hint" aria-label={text}>
        i
      </button>
      <span aria-hidden="true" className="webui-settings-info-hint-bubble">
        {text}
      </span>
    </span>
  );
}

function SectionHeader({
  title,
  hintTestId,
  hint,
  children,
}: {
  readonly title: string;
  readonly hint: string;
  readonly hintTestId: string;
  readonly children?: ReactNode;
}): ReactElement {
  return (
    <div className="webui-personalization-header">
      {/* Title and hint travel together: the header is `space-between`, so
          three loose children would push the action button into the middle. */}
      <div className="webui-personalization-title">
        <h3>{title}</h3>
        <InfoHint text={hint} testId={hintTestId} />
      </div>
      {children}
    </div>
  );
}

/** One switch row inside the 记忆 card. Mirrors the desktop's row grammar. */
function MemoryRow({
  title,
  description,
  testId,
  children,
}: {
  readonly title: string;
  readonly description: string;
  readonly testId: string;
  readonly children: ReactNode;
}): ReactElement {
  return (
    <div data-testid={testId} className="webui-generic-row">
      <div className="webui-generic-row-copy">
        <strong>{title}</strong>
        <span>{description}</span>
      </div>
      <div className="webui-generic-row-control">{children}</div>
    </div>
  );
}

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
  readonly getUserProfile?: () => Promise<WebuiUserProfileView>;
  readonly setUserProfile?: (request: {
    readonly content: string;
  }) => Promise<WebuiUserProfileView>;
  readonly getMemorySettings?: () => Promise<WebuiMemorySettingsView>;
  readonly setMemorySettings?: (request: {
    readonly enabled?: boolean;
    readonly proactive?: boolean;
  }) => Promise<WebuiMemorySettingsView>;
  /** 「在会话中创建」. Optional on purpose: without a host that can receive the
   *  hand-off the menu item is not rendered at all, rather than rendered and
   *  quietly doing nothing when clicked. */
  readonly onCreateInSession?: (input: MemoryHandoff) => void;
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

export function PersonalizationSettings(props: PersonalizationSettingsProps): ReactElement {
  return (
    <div data-testid="content-body" className="webui-personalization-page">
      <GlobalInstructionsSection {...props} />
      <UserProfileSection
        getUserProfile={props.getUserProfile}
        setUserProfile={props.setUserProfile}
      />
      <MemorySection
        getAgentMemory={props.getAgentMemory}
        setAgentMemory={props.setAgentMemory}
        getMemorySettings={props.getMemorySettings}
        setMemorySettings={props.setMemorySettings}
        {...(props.onCreateInSession ? { onCreateInSession: props.onCreateInSession } : {})}
      />
    </div>
  );
}

function GlobalInstructionsSection({
  getGlobalInstructions,
  setGlobalInstructions,
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
    <section
      data-testid="global-instructions-section"
      className="webui-generic-section"
    >
      <SectionHeader
        title="自定义指令"
        hint={PERSONALIZATION_SECTION_HINTS.globalInstructions}
        hintTestId="global-instructions-hint"
      >
        <button
          type="button"
          data-testid="global-instructions-save"
          className="webui-mavis-button webui-mavis-button-gray"
          disabled={!dirty || saving || overLimit || !setGlobalInstructions}
          onClick={() => void save()}
        >
          保存
        </button>
      </SectionHeader>
      <div className="webui-generic-card">
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
      </div>
    </section>
  );
}

export interface UserProfileSectionProps {
  readonly getUserProfile?: () => Promise<WebuiUserProfileView>;
  readonly setUserProfile?: (request: {
    readonly content: string;
  }) => Promise<WebuiUserProfileView>;
}

/**
 * 关于你 — the marked region of `user.md`.
 *
 * The editor shows the region and nothing else. The same file also carries
 * `mem-append-reason` entries the memory collector appends, and the
 * `<user_profile>` prompt block is built from the marked region only, so
 * exposing the whole file would both leak entries the user never wrote and let
 * them edit text the model never reads.
 *
 * A malformed file (one marker without the other) renders as a refusal rather
 * than an empty editor: an empty editor invites a save, and that save is
 * exactly the write the server refuses.
 */
export function UserProfileSection({
  getUserProfile,
  setUserProfile,
}: UserProfileSectionProps): ReactElement {
  const [draft, setDraft] = useState<string>();
  const [maxChars, setMaxChars] = useState(10 * 1024);
  const [malformed, setMalformed] = useState(false);
  const [filePath, setFilePath] = useState("");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string>();

  useEffect(() => {
    if (!getUserProfile) return;
    let cancelled = false;
    void getUserProfile()
      .then((value) => {
        if (cancelled || !value) return;
        setDraft(value.content);
        setMaxChars(value.maxChars);
        setMalformed(value.malformed);
        setFilePath(value.path);
      })
      .catch((cause: unknown) => {
        if (cancelled) return;
        setError(cause instanceof Error ? cause.message : String(cause));
      });
    return () => {
      cancelled = true;
    };
  }, [getUserProfile]);

  const length = draft?.length ?? 0;
  const overLimit = length > maxChars;
  const saveable =
    draft !== undefined && !malformed && Boolean(setUserProfile) && !overLimit;

  const save = useCallback(async () => {
    if (!setUserProfile || saving || draft === undefined || malformed) return;
    setSaving(true);
    setError(undefined);
    try {
      const next = await setUserProfile({ content: draft });
      if (next) {
        setDraft(next.content);
        setMaxChars(next.maxChars);
        setMalformed(next.malformed);
        setFilePath(next.path);
      }
      setSaved(true);
    } catch (cause: unknown) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSaving(false);
    }
  }, [draft, malformed, saving, setUserProfile]);

  return (
    <section data-testid="user-profile-section" className="webui-generic-section">
      <SectionHeader
        title="关于你"
        hint={PERSONALIZATION_SECTION_HINTS.userProfile}
        hintTestId="user-profile-hint"
      >
        <button
          type="button"
          data-testid="user-profile-save"
          className="webui-mavis-button webui-mavis-button-gray"
          disabled={!saveable || saving}
          onClick={() => void save()}
        >
          保存
        </button>
      </SectionHeader>
      <div className="webui-generic-card">
        <textarea
          data-testid="user-profile-textarea"
          className="webui-personalization-textarea"
          value={draft ?? ""}
          spellCheck={false}
          placeholder={PROFILE_PLACEHOLDER}
          disabled={malformed || draft === undefined}
          onChange={(event) => {
            setDraft(event.target.value);
            setSaved(false);
          }}
        />
        <div className="webui-personalization-meta">
          <span data-testid="user-profile-path">{filePath}</span>
          <span
            data-testid="user-profile-size"
            className={overLimit ? "is-over-limit" : undefined}
          >
            {length} / {maxChars} 字符
          </span>
        </div>
        {overLimit ? (
          <p role="alert" data-testid="user-profile-over-limit" className="webui-settings-error">
            超过 {maxChars} 字符后，超出部分不会注入提示，请精简后再保存。
          </p>
        ) : null}
        {malformed ? (
          <p role="alert" data-testid="user-profile-malformed" className="webui-settings-error">
            user.md 的标记不完整，为避免覆盖记忆中已收集的内容，这里不做写入。
          </p>
        ) : null}
        {error ? (
          <p role="alert" data-testid="user-profile-error" className="webui-settings-error">
            {error}
          </p>
        ) : null}
        {saved && !saving ? (
          <p data-testid="user-profile-saved" className="webui-personalization-saved">
            已保存
          </p>
        ) : null}
        {!getUserProfile || !setUserProfile ? (
          <p data-testid="user-profile-unavailable" className="webui-settings-error">
            当前运行时不支持「关于你」读写。
          </p>
        ) : null}
      </div>
    </section>
  );
}

export interface MemorySectionProps {
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
 * Both switches write through to the shared config, so they are global: the
 * WebUI is one surface of the desktop app, not a separate settings scope. That
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
  const [summary, setSummary] = useState<WebuiAgentMemoryView>();
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

  const readSummary = useCallback(() => {
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

  useEffect(readSummary, [readSummary]);

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
    <section data-testid="memory-section" className="webui-generic-section">
      <SectionHeader
        title="记忆"
        hint={PERSONALIZATION_SECTION_HINTS.memory}
        hintTestId="memory-hint"
      />
      <div className="webui-generic-card">
        <MemoryRow
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
        </MemoryRow>
        <MemoryRow
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
        </MemoryRow>
        <MemoryRow
          title="记忆摘要"
          description="查看、编辑或删除 MiniMax 已整理的长期记忆。"
          testId="memory-summary-row"
        >
          <span data-testid="memory-summary-size" className="webui-personalization-meta">
            {summary?.exists ? `${summary.sizeBytes} 字节` : "暂无"}
          </span>
          <button
            type="button"
            data-testid="agent-memory-load"
            className="webui-mavis-button webui-mavis-button-gray"
            disabled={!getAgentMemory || !setAgentMemory}
            onClick={() => setManaging((open) => !open)}
          >
            管理
          </button>
        </MemoryRow>
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
            onChanged={readSummary}
            {...(onCreateInSession ? { onCreateInSession } : {})}
          />
        ) : null}
      </div>
    </section>
  );
}

/**
 * `更新于 2026-10-06 04:48:48`, the shape the desktop footer uses.
 *
 * Formatted by hand rather than through `toLocaleString` so the separators do
 * not follow the host locale — the panel is Chinese, but the browser can be
 * running under any locale, and a footer that changes shape with the OS is a
 * footer nobody can screenshot-compare. Returns `""` for a missing or
 * unparseable stamp rather than "Invalid Date".
 */
export function formatMemoryTimestamp(value: string | undefined): string {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const pad = (part: number): string => String(part).padStart(2, "0");
  const stamp = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
  return `更新于 ${stamp}`;
}

/** Byte count for the delete confirmation. Plain KB above a kilobyte so the
 *  number in front of an irreversible action is the one the user can compare
 *  against the row's 字节 figure, not a unit conversion they have to undo. */
export function formatMemorySize(bytes: number): string {
  if (bytes < 1024) return `${bytes} 字节`;
  return `${Math.round(bytes / 1024)} KB`;
}

/** What 「在会话中创建」 leaves in the composer, beside the attached file.
 *  The desktop lands on the home surface with exactly this one line already
 *  typed, so the user's next action is to add what they actually want changed. */
export const MEMORY_HANDOFF_PROMPT = "我想调整下这个记忆文件";

export interface MemoryManagerDialogProps {  readonly getAgentMemory?: (request?: {
    readonly includeContent?: boolean;
  }) => Promise<WebuiAgentMemoryView>;
  readonly setAgentMemory?: (request: {
    readonly content: string;
  }) => Promise<WebuiAgentMemoryView>;
  readonly onClose: () => void;
  /** Re-read the row's size after a write or a delete, so 记忆摘要 cannot keep
   *  reporting the size of a file this dialog just changed. */
  readonly onChanged?: () => void;
  /** Hand the memory to a conversation instead of editing it here. Omitted when
   *  the host has nowhere to put it — the item then stays out of the menu rather
   *  than opening a composer the shell cannot reach. */
  readonly onCreateInSession?: (input: MemoryHandoff) => void;
}

/** What 「在会话中创建」 carries across: the body plus the identity the composer
 *  chip needs. `token` makes the hand-off one-shot — the composer remembers the
 *  last token it consumed, so a re-render cannot double-attach a 74KB file. */
export interface MemoryHandoff {
  readonly token: string;
  readonly fileName: string;
  readonly mimeType: string;
  readonly sizeBytes: number;
  readonly content: string;
}

/**
 * The body behind 管理.
 *
 * Summary first, body on request: the first paint must not already contain the
 * editor, because a live main file runs past the runtime's 64KB cleanup
 * threshold and the row that opened the manager only needed the size.
 *
 * This is main memory, not `writeMemorySummary` — the runtime rejects summary
 * content over 4KB, so a textarea wired to the summary would reject exactly the
 * content this panel exists to show.
 */
export function MemoryManagerDialog({
  getAgentMemory,
  setAgentMemory,
  onClose,
  onChanged,
  onCreateInSession,
}: MemoryManagerDialogProps): ReactElement {
  const [draft, setDraft] = useState<string>();
  const [updatedAt, setUpdatedAt] = useState<string>();
  const [filePath, setFilePath] = useState<string>();
  const [fileSize, setFileSize] = useState(0);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string>();
  const [menuOpen, setMenuOpen] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  // The document-level Escape handler below is keyed on `onClose` alone so it
  // never tears down and re-steals focus on every keystroke. It therefore
  // cannot close over `menuOpen`; this ref is how it still sees the flag.
  const menuOpenRef = useRef(false);
  menuOpenRef.current = menuOpen;

  const load = useCallback(async (reader: NonNullable<MemoryManagerDialogProps["getAgentMemory"]>) => {
    setLoading(true);
    setError(undefined);
    try {
      const value = await reader({ includeContent: true });
      if (!value) return;
      setDraft(value.content ?? "");
      setUpdatedAt(value.updatedAt);
      setFilePath(value.path);
      setFileSize(value.sizeBytes);
    } catch (cause: unknown) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoading(false);
    }
  }, []);

  /**
   * The body loads on open. The desktop takes 管理 straight into the editor,
   * and a second click to start reading is a step the user has to learn for
   * nothing — the file is the whole point of opening the dialog.
   *
   * The reader is reached through a ref and the effect is keyed on nothing, on
   * purpose. Keyed on `getAgentMemory`, any parent that hands down a fresh
   * closure would re-run this after every keystroke and replace the text being
   * typed: the editor would look like it was refreshing, and the edit would be
   * silently discarded. A load that can fire more than once per open is worse
   * than no load at all.
   */
  const readerRef = useRef(getAgentMemory);
  useEffect(() => {
    readerRef.current = getAgentMemory;
  }, [getAgentMemory]);
  useEffect(() => {
    const reader = readerRef.current;
    if (reader) void load(reader);
  }, [load]);

  const save = useCallback(async () => {
    if (!setAgentMemory || saving || draft === undefined) return;
    setSaving(true);
    setError(undefined);
    try {
      await setAgentMemory({ content: draft });
      setSaved(true);
      onChanged?.();
    } catch (cause: unknown) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSaving(false);
    }
  }, [draft, saving, setAgentMemory, onChanged]);

  /**
   * 删除记忆 is a blank write, not a new capability.
   *
   * `writeAgentMemory` already treats empty content as "remove the file" — the
   * runtime's own write contract does the same — so the menu item is a named
   * shortcut for something the editor could already do by emptying the textarea
   * and saving. That is worth stating plainly, because it is also the reason
   * this needs a confirmation: the path it takes is the one that unlinks a
   * 74KB file of accumulated lessons, with nothing to undo it from.
   */
  const remove = useCallback(async () => {
    if (!setAgentMemory || saving) return;
    setSaving(true);
    setError(undefined);
    try {
      await setAgentMemory({ content: "" });
      setDraft(undefined);
      setUpdatedAt(undefined);
      setFileSize(0);
      setConfirmingDelete(false);
      setMenuOpen(false);
      onChanged?.();
    } catch (cause: unknown) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSaving(false);
    }
  }, [saving, setAgentMemory, onChanged]);

  const handoffSequence = useRef(0);
  const handoff = useCallback(() => {
    if (!onCreateInSession || draft === undefined || !filePath) return;
    const fileName = filePath.split("/").pop() ?? "MEMORY.md";
    handoffSequence.current += 1;
    onCreateInSession({
      token: `${fileName}:${fileSize}:${handoffSequence.current}`,
      fileName,
      mimeType: fileName.toLowerCase().endsWith(".md") ? "text/markdown" : "text/plain",
      sizeBytes: fileSize,
      content: draft,
    });
    setMenuOpen(false);
    onClose();
  }, [draft, filePath, fileSize, onClose, onCreateInSession]);

  /**
   * Escape has to be heard on the document, and focus has to be moved in by
   * hand. The dialog is portalled to `document.body`, so it is not a DOM
   * descendant of the row that opened it: a `keydown` handler on the surface
   * only ever sees keys typed after focus happens to land inside, and on open
   * focus is still on 管理. Listening on the surface alone therefore left the
   * one key every modal is expected to honour doing nothing.
   *
   * Unmount restores focus to whatever held it before, so closing with Escape
   * leaves the keyboard on the row the user came from.
   */
  const surfaceRef = useRef<HTMLElement | null>(null);
  useEffect(() => {
    const restoreTo = document.activeElement;
    surfaceRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      // An open menu is a layer above the dialog, so Escape sheds that layer
      // first. Dismissing the whole dialog instead would throw away the
      // 74KB draft behind it, which is not what pressing Escape once means.
      if (menuOpenRef.current) {
        setMenuOpen(false);
        return;
      }
      onClose();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      if (restoreTo instanceof HTMLElement) restoreTo.focus();
    };
  }, [onClose]);

  const dialog = (
    <div
      data-testid="agent-memory-manager"
      className="webui-memory-manager-mask"
      onMouseDown={(event) => {
        // Shed the menu before the dialog: a click on the scrim with a menu
        // open means "put that away", not "discard the memory editor".
        if (event.target !== event.currentTarget) return;
        if (menuOpenRef.current) {
          setMenuOpen(false);
          return;
        }
        onClose();
      }}
    >
      <section
        ref={surfaceRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label="记忆摘要"
        className="webui-memory-manager-surface"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="webui-personalization-header">
          <h3>记忆摘要</h3>
          <div className="webui-memory-manager-header-actions">
            <button
              type="button"
              aria-label="更多操作"
              aria-haspopup="menu"
              aria-expanded={menuOpen}
              data-testid="agent-memory-menu"
              className="webui-settings-icon-button"
              onClick={() => setMenuOpen((open) => !open)}
            >
              <svg aria-hidden="true" width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
                <circle cx="3" cy="8" r="1.4" />
                <circle cx="8" cy="8" r="1.4" />
                <circle cx="13" cy="8" r="1.4" />
              </svg>
            </button>
            <button
              type="button"
              aria-label="关闭"
              data-testid="agent-memory-close"
              className="webui-settings-icon-button"
              onClick={onClose}
            >
              <svg aria-hidden="true" width="16" height="16" viewBox="0 0 16 16" fill="none">
                <path d="m4 4 8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.35" strokeLinecap="round" />
              </svg>
            </button>
          </div>
          {menuOpen ? (
            <div role="menu" aria-label="记忆操作" data-testid="agent-memory-menu-panel" className="webui-memory-manager-menu">
              {onCreateInSession ? (
                <button type="button" role="menuitem" data-testid="agent-memory-create-in-session" onClick={handoff}>
                  <svg aria-hidden="true" width="14" height="14" viewBox="0 0 16 16" fill="none" className="webui-memory-manager-menu-icon">
                    <path d="M14 10.5a2 2 0 0 1-2 2H6l-3.5 2.5V4.5a2 2 0 0 1 2-2h7.5a2 2 0 0 1 2 2v6Z" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
                  </svg>
                  在会话中创建
                </button>
              ) : null}
              <button
                type="button"
                role="menuitem"
                data-testid="agent-memory-delete"
                className="is-danger"
                disabled={!setAgentMemory || draft === undefined}
                onClick={() => {
                  // Shed the menu as it opens the confirmation: leaving it up
                  // puts a second copy of 删除记忆 on top of the thing it just
                  // opened, so the panel looks like it has two delete buttons.
                  setMenuOpen(false);
                  setConfirmingDelete(true);
                }}
              >
                <svg aria-hidden="true" width="14" height="14" viewBox="0 0 16 16" fill="none" className="webui-memory-manager-menu-icon">
                  <path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.6 8a1 1 0 0 0 1 .9h3.8a1 1 0 0 0 1-.9l.6-8" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
                删除记忆
              </button>
            </div>
          ) : null}
        </div>
        {confirmingDelete ? (
          <div role="alertdialog" aria-modal="true" aria-label="确认删除记忆" data-testid="agent-memory-delete-confirm" className="webui-memory-manager-confirm">
            <p>
              将删除 <strong>{formatMemorySize(fileSize)}</strong> 的长期记忆文件，删除后无法恢复。
            </p>
            <div className="webui-memory-manager-actions">
              <button type="button" className="webui-mavis-button webui-mavis-button-gray" data-testid="agent-memory-delete-cancel" onClick={() => setConfirmingDelete(false)}>
                取消
              </button>
              <button
                type="button"
                className="webui-mavis-button webui-mavis-button-danger"
                data-testid="agent-memory-delete-confirm-button"
                disabled={saving}
                onClick={() => void remove()}
              >
                {saving ? "删除中…" : "删除"}
              </button>
            </div>
          </div>
        ) : null}
        {loading ? (
          <p data-testid="agent-memory-loading" className="webui-personalization-meta">
            加载中…
          </p>
        ) : draft === undefined ? null : (
          <div className="webui-memory-manager-editor">
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
            <span data-testid="agent-memory-chars" className="webui-personalization-meta">
              {draft.length}
            </span>
          </div>
        )}
        {error ? (
          <p role="alert" data-testid="agent-memory-error" className="webui-settings-error">
            {error}
          </p>
        ) : null}
        {error && draft === undefined && getAgentMemory ? (
          <button
            type="button"
            data-testid="agent-memory-retry"
            className="webui-mavis-button webui-mavis-button-gray"
            disabled={loading}
            onClick={() => void load(getAgentMemory)}
          >
            重试
          </button>
        ) : null}
        {saved && !saving ? (
          <p data-testid="agent-memory-saved" className="webui-personalization-saved">
            已保存
          </p>
        ) : null}
        <footer className="webui-memory-manager-footer">
          <span data-testid="agent-memory-updated" className="webui-personalization-meta">
            {formatMemoryTimestamp(updatedAt)}
          </span>
          <div className="webui-memory-manager-actions">
            <button type="button" className="webui-mavis-button webui-mavis-button-gray" onClick={onClose}>
              取消
            </button>
            <button
              type="button"
              data-testid="agent-memory-save"
              className="webui-mavis-button webui-mavis-button-gray"
              disabled={saving || loading || draft === undefined || !setAgentMemory}
              onClick={() => void save()}
            >
              {saving ? "保存中…" : "保存"}
            </button>
          </div>
        </footer>
      </section>
    </div>
  );

  /**
   * Portalled to the body on purpose. The settings shell is a `z-index: 100`
   * fixed overlay, and anything with a position and a z-index becomes a
   * stacking context — a dialog rendered inside it can never paint above the
   * shell no matter how large its own z-index is. The same reason
   * `UserMenu` portals the settings modal itself out of the rail.
   */
  return typeof document === "undefined" ? dialog : createPortal(dialog, document.body);
}
