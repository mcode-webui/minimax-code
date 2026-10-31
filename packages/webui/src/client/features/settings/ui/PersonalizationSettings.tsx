import { useMemo, type ReactElement } from "react";
import type { WebuiAgentMemoryView, WebuiGlobalInstructionsView, WebuiMemorySettingsView, WebuiUserProfileFields, WebuiUserProfileView } from "../../../../shared/contracts/personalization.js";
import { useWebuiSettingsWorkflows, useWebuiSettingsWorkflowsState } from "../../../bindings/use-query-state.js";
import { SettingsPage } from "../../../ui/settings-layout.js";
import type { WebuiResourceLoadOutcome } from "../../../conversation/request-freshness.js";
import type { MemoryHandoff } from "../contracts/memory-handoff.js";
import { GlobalInstructionsSection } from "./GlobalInstructionsSection.js";
import { UserProfileSection } from "./UserProfileSection.js";
import { MemorySection } from "./MemorySection.js";

/**
 * Personalization panel — the three blocks: 自定义指令, 关于你, 记忆.
 *
 * Shape note: 记忆 is a card of three rows (two switches plus a 管理 action
 * that opens the memory manager), not a single textarea.
 *
 * Scope note: this component lands in the same settings modal the shell owns,
 * but the two do not overlap in behaviour. The shell owns the tab list, groups
 * and search filtering; this component owns one tab body and the transport
 * calls behind it.
 *
 * Boundary note: the browser switches are not here. They are their own tab —
 * 浏览器 — because the browser business owns that vocabulary, and a page of
 * this business's preferences is not where another business's settings live.
 */

/**
 * The delete confirmation's copy, word for word.
 *
 * The half-width `?` is deliberate, not a typo to tidy up: a full-width
 * `？` carries a full em of advance and visibly opens a gap after 忆, and the
 * dialog does not have one. The body deliberately carries no byte
 * count either, and the row above the button already
 * shows the figure the user would compare it against.
 */
export const MEMORY_DELETE_CONFIRM = {
  title: "删除记忆?",
  body: "MiniMax Code 将不再记住关于你的重要信息，你的使用体验将少一些个性化。",
  cancel: "取消",
  confirm: "删除",
} as const;

export interface PersonalizationSettingsProps {
  /** 「在会话中创建」. Optional on purpose: without a host that can receive the
   *  hand-off the menu item is not rendered at all, rather than rendered and
   *  quietly doing nothing when clicked. */
  readonly onCreateInSession?: (input: MemoryHandoff) => void;
}

/**
 * Personalization panel — the settings owner's per-surface consumer.
 *
 * Every read and write below is derived from the settings workflow owner: this
 * component calls the owner's commands and reads its snapshot, and hands the
 * three section components the same read/write callback shape they always
 * took. The sections keep their own uncommitted editor state; only what was
 * submitted belongs to the application.
 */

/**
 * What a section's callback expects: the value, or a throw it can render.
 *
 * The owner already reports what each request produced, so a surface does not
 * re-read the shared snapshot to discover its own result. It converts that one
 * outcome here, in one place, instead of repeating the conversion per read.
 *
 * A request that was superseded, disposed or refused throws rather than
 * resolving to `undefined`: "I have nothing to show" and "the read was refused"
 * are different, and collapsing them is what made a dropped answer look like an
 * empty field the user could overwrite.
 */
function valueOrThrow<T>(outcome: WebuiResourceLoadOutcome<T>, unsupported: string): T {
  switch (outcome.status) {
    case "ready":
      return outcome.value;
    case "failed":
      throw outcome.error instanceof Error ? outcome.error : new Error(String(outcome.error));
    default:
      throw new Error(unsupported);
  }
}

export function PersonalizationSettings({ onCreateInSession }: PersonalizationSettingsProps = {}): ReactElement {
  const settings = useWebuiSettingsWorkflows();
  // Subscribe so a settings write anywhere re-renders this consumer. The
  // sections hold their own editor state and read the snapshot imperatively,
  // so the values themselves are not threaded through here.
  useWebuiSettingsWorkflowsState();

  const sections = useMemo(() => {
    const s = settings;
    const getGlobalInstructions = s && s.canReadInstructions
      ? async (): Promise<WebuiGlobalInstructionsView> =>
          valueOrThrow(await s.loadInstructions(), "当前运行时不支持自定义指令读写。")
      : undefined;
    const setGlobalInstructions = s && s.canWriteInstructions
      ? async (request: { readonly content: string }): Promise<WebuiGlobalInstructionsView> => s.saveInstructions(request.content)
      : undefined;
    const getUserProfile = s && s.canReadProfile
      ? async (): Promise<WebuiUserProfileView> =>
          valueOrThrow(await s.loadProfile(), "当前运行时不支持「关于你」读写。")
      : undefined;
    const setUserProfile = s && s.canWriteProfile
      ? async (request: WebuiUserProfileFields): Promise<WebuiUserProfileView> => s.saveProfile(request)
      : undefined;
    // The owner reads the summary and the body as two identities, selected by
    // `includeContent`. The section asks for one or the other and receives that
    // request's own answer — the panel never has to work out which of the two a
    // cached value represents.
    const getAgentMemory = s && s.canReadMemory
      ? async (request?: { readonly includeContent?: boolean }): Promise<WebuiAgentMemoryView> =>
          valueOrThrow(
            await s.loadAgentMemory(request?.includeContent === true),
            "当前运行时不支持长期记忆读写。",
          )
      : undefined;
    const setAgentMemory = s && s.canWriteMemory
      ? async (request: { readonly content: string }): Promise<WebuiAgentMemoryView> => s.saveAgentMemory(request.content)
      : undefined;
    const getMemorySettings = s && s.canReadMemorySettings
      ? async (): Promise<WebuiMemorySettingsView> =>
          valueOrThrow(await s.loadMemorySettings(), "当前运行时不支持记忆开关。")
      : undefined;
    const setMemorySettings = s && s.canWriteMemorySettings
      ? async (request: { readonly enabled?: boolean; readonly proactive?: boolean }): Promise<WebuiMemorySettingsView> => s.saveMemorySettings(request)
      : undefined;
    return {
      getGlobalInstructions,
      setGlobalInstructions,
      getUserProfile,
      setUserProfile,
      getAgentMemory,
      setAgentMemory,
      getMemorySettings,
      setMemorySettings,
    };
  }, [settings]);

  return (
    <SettingsPage testId="content-body">
      <GlobalInstructionsSection
        getGlobalInstructions={sections.getGlobalInstructions}
        setGlobalInstructions={sections.setGlobalInstructions}
      />
      <UserProfileSection
        getUserProfile={sections.getUserProfile}
        setUserProfile={sections.setUserProfile}
      />
      <MemorySection
        getAgentMemory={sections.getAgentMemory}
        setAgentMemory={sections.setAgentMemory}
        getMemorySettings={sections.getMemorySettings}
        setMemorySettings={sections.setMemorySettings}
        {...(onCreateInSession ? { onCreateInSession } : {})}
      />
    </SettingsPage>
  );
}
