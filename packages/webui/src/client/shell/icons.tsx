// Shared WebUI icon vocabulary. Keep product marks as assets and use Tabler for interface glyphs.

import type { ReactElement } from "react";
import {
  IconArchive, IconArrowBackUp, IconArrowUp, IconBell, IconBug, IconCirclePlus,
  IconCalendarEvent, IconCaretRightFilled, IconChartBar, IconCheck, IconChevronDown, IconChevronLeft,
  IconChevronRight, IconClipboard, IconCode, IconCopy, IconDeviceMobile, IconDots,
  IconDownload, IconEdit, IconFile, IconFileCode, IconFolder, IconFolderPlus,
  IconGitBranch, IconGitCompare, IconGitFork, IconHierarchy, IconHome, IconInfoCircle, IconLayoutDashboard, IconMaximize,
  IconLayoutSidebar, IconMapPin, IconMessage, IconMessageCircle, IconMessageQuestion,
  IconMinimize, IconPaperclip, IconPin, IconPinFilled, IconPuzzle, IconRefresh, IconSearch,
  IconShieldCheck, IconShieldLock, IconShieldX, IconSparkles,
  IconTarget, IconTerminal2, IconThumbDown, IconThumbUp, IconTrash, IconWorld,
  IconX,
} from "@tabler/icons-react";

export interface WebuiIconProps {
  readonly className?: string;
}

export interface WebuiSizedIconProps extends WebuiIconProps {
  readonly size?: number;
}

type IconComponent = typeof IconCheck;

function glyph(Icon: IconComponent, className?: string, size = 18): ReactElement {
  return <Icon aria-hidden="true" className={className} size={size} stroke={1.7} />;
}

export function WebuiIconCheck({ className }: WebuiIconProps): ReactElement { return glyph(IconCheck, className, 16); }
export function WebuiIconChevronLeft({ className }: WebuiIconProps): ReactElement { return glyph(IconChevronLeft, className, 16); }
export function WebuiIconChevronRight({ className }: WebuiIconProps): ReactElement { return glyph(IconChevronRight, className, 16); }
export function WebuiIconClose({ className }: WebuiIconProps): ReactElement { return glyph(IconX, className, 16); }
export function WebuiIconReload({ className }: WebuiIconProps): ReactElement { return glyph(IconRefresh, className, 16); }
export function WebuiIconGlobe({ className }: WebuiIconProps): ReactElement { return glyph(IconWorld, className, 16); }
export function WebuiIconHome({ className }: WebuiIconProps): ReactElement { return glyph(IconHome, className, 16); }

/** Product mark. This custom MiniMax glyph is branding, not a UI icon. */
export function WebuiIconBrand({ className }: WebuiIconProps): ReactElement {
  return <img src="/assets/img/minimax-code-agent-icon.png" alt="" aria-hidden="true" className={className} />;
}
export function WebuiIconAgent({ className }: WebuiIconProps): ReactElement {
  return <img src="/assets/img/minimax-code-agent-icon.png" alt="" aria-hidden="true" className={className} />;
}
export function WebuiIconNewTask({ className }: WebuiIconProps): ReactElement { return glyph(IconCirclePlus, className); }
export function WebuiIconPlugins({ className }: WebuiIconProps): ReactElement { return glyph(IconPuzzle, className); }
export function WebuiIconSites({ className }: WebuiIconProps): ReactElement { return glyph(IconLayoutDashboard, className); }
export function WebuiIconRemote({ className }: WebuiIconProps): ReactElement { return glyph(IconDeviceMobile, className); }
export function WebuiIconBell({ className }: WebuiIconProps): ReactElement { return glyph(IconBell, className, 20); }
export function WebuiIconAttach({ className }: WebuiIconProps): ReactElement { return glyph(IconPaperclip, className); }
export function WebuiIconChevronDown({ className }: WebuiIconProps): ReactElement { return glyph(IconChevronDown, className, 16); }
export function WebuiIconSessionDisclosure({ className }: WebuiIconProps): ReactElement { return glyph(IconChevronRight, className, 14); }
/** Filled disclosure arrow retained for expandable parent-session rows. */
export function WebuiIconSessionTreeDisclosure({ className }: WebuiIconProps): ReactElement { return glyph(IconCaretRightFilled, className, 14); }
export function WebuiIconPermissionRequest({ className }: WebuiIconProps): ReactElement { return glyph(IconShieldLock, className); }
export function WebuiIconPermissionAuto({ className }: WebuiIconProps): ReactElement { return glyph(IconShieldCheck, className); }
export function WebuiIconPermissionFull({ className }: WebuiIconProps): ReactElement { return glyph(IconShieldX, className); }
/** The model picker's own glyph, for the trigger's narrow form. */
export function WebuiIconModel({ className }: WebuiIconProps): ReactElement { return glyph(IconSparkles, className); }
export function WebuiIconFile({ className }: WebuiIconProps): ReactElement { return glyph(IconFile, className); }
export function WebuiIconDiffSummary({ className }: WebuiIconProps): ReactElement { return glyph(IconGitCompare, className); }
export function WebuiIconDiffFile({ className }: WebuiIconProps & { readonly fileName?: string }): ReactElement { return glyph(IconFileCode, className); }
export function WebuiIconSend({ className }: WebuiIconProps): ReactElement { return glyph(IconArrowUp, className); }
export function WebuiIconFolder({ className }: WebuiIconProps): ReactElement { return glyph(IconFolder, className); }
export function WebuiIconSession({ className }: WebuiIconProps): ReactElement { return glyph(IconMessage, className); }
export function WebuiIconMore({ className }: WebuiIconProps): ReactElement { return glyph(IconDots, className); }
export function WebuiIconProjectAdd({ className }: WebuiIconProps): ReactElement { return glyph(IconFolderPlus, className); }
export function WebuiIconSessionPinMark({ className }: WebuiIconProps): ReactElement { return glyph(IconPin, className, 14); }
export function WebuiIconSessionPin({ className }: WebuiIconProps): ReactElement { return glyph(IconPin, className); }
export function WebuiIconContextPin({ className, pinned = false }: WebuiIconProps & { pinned?: boolean }): ReactElement {
  // The pinned state draws the filled pin and the unpinned one the outline, so
  // a pinned row reads as pinned without the label having to say it. The glyph
  // used to say it through a hand-drawn slashed variant; the tabler pair says
  // it the same way.
  return glyph(pinned ? IconPinFilled : IconPin, className);
}
export function WebuiIconContextRename({ className }: WebuiIconProps): ReactElement { return glyph(IconEdit, className); }
export function WebuiIconContextArchive({ className }: WebuiIconProps): ReactElement { return glyph(IconArchive, className); }
export function WebuiIconContextFork({ className }: WebuiIconProps): ReactElement { return glyph(IconGitFork, className); }
export function WebuiIconContextCopy({ className }: WebuiIconProps): ReactElement { return glyph(IconCopy, className); }
export function WebuiIconContextFeedback({ className }: WebuiIconProps): ReactElement { return glyph(IconMessageCircle, className); }
export function WebuiIconContextExport({ className }: WebuiIconProps): ReactElement { return glyph(IconDownload, className); }
export function WebuiIconSessionImport({ className }: WebuiIconProps): ReactElement { return glyph(IconArrowBackUp, className); }
export function WebuiIconContextTrash({ className }: WebuiIconProps): ReactElement { return glyph(IconTrash, className); }
export function WebuiIconContextChevron({ className }: WebuiIconProps): ReactElement {
  // The submenu chevron sits in a 16px slot (`.webui-context-menu-chevron`),
  // so it draws at 16 — the same size the other chevrons draw at.
  return glyph(IconChevronRight, className, 16);
}
export function WebuiIconRunLocation({ className }: WebuiIconProps): ReactElement { return glyph(IconMapPin, className); }
export function WebuiIconSidebarToggle({ className }: WebuiIconProps): ReactElement { return glyph(IconLayoutSidebar, className); }
export function WebuiIconSearch({ className }: WebuiIconProps): ReactElement { return glyph(IconSearch, className); }
export function WebuiIconWorkspaceReview({ className }: WebuiIconProps): ReactElement { return glyph(IconGitBranch, className); }
export function WebuiIconWorkspaceTerminal({ className }: WebuiIconProps): ReactElement { return glyph(IconTerminal2, className); }
export function WebuiIconWorkspaceCanvas({ className }: WebuiIconProps): ReactElement { return glyph(IconHierarchy, className); }
export function WebuiIconWorkspaceExpand({ className, expanded = false }: WebuiIconProps & { readonly expanded?: boolean }): ReactElement { return glyph(expanded ? IconMinimize : IconMaximize, className); }
export function WebuiIconCommandCompact({ className }: WebuiIconProps): ReactElement { return glyph(IconMinimize, className); }
export function WebuiIconCommandHelp({ className }: WebuiIconProps): ReactElement { return glyph(IconMessageQuestion, className); }
export function WebuiIconCommandStatus({ className }: WebuiIconProps): ReactElement { return glyph(IconInfoCircle, className); }
export function WebuiIconCommandUsage({ className }: WebuiIconProps): ReactElement { return glyph(IconChartBar, className); }
export function WebuiIconCommandGoal({ className }: WebuiIconProps): ReactElement { return glyph(IconTarget, className); }
export function WebuiIconCommandPlan({ className }: WebuiIconProps): ReactElement { return glyph(IconCalendarEvent, className); }
export function WebuiIconSkillAskMatt({ className }: WebuiIconProps): ReactElement { return glyph(IconMessageQuestion, className); }
export function WebuiIconSkillCodeReview({ className }: WebuiIconProps): ReactElement { return glyph(IconCode, className); }
export function WebuiIconSkillCodebaseDesign({ className }: WebuiIconProps): ReactElement { return glyph(IconHierarchy, className); }
export function WebuiIconSkillDiagnosingBugs({ className }: WebuiIconProps): ReactElement { return glyph(IconBug, className); }
export function WebuiIconSkillGeneric({ className }: WebuiIconProps): ReactElement { return glyph(IconPuzzle, className); }
export function WebuiIconMessageCopy({ className, size = 20 }: WebuiSizedIconProps): ReactElement { return glyph(IconClipboard, className, size); }
export function WebuiIconMessageCopied({ className, size = 20 }: WebuiSizedIconProps): ReactElement { return glyph(IconCheck, className, size); }
export function WebuiIconMessageRewind({ className, size = 20 }: WebuiSizedIconProps): ReactElement { return glyph(IconRefresh, className, size); }
export function WebuiIconMessageEdit({ className, size = 16 }: WebuiSizedIconProps): ReactElement { return glyph(IconEdit, className, size); }
export function WebuiIconMessageEditUser({ className, size = 20 }: WebuiSizedIconProps): ReactElement { return glyph(IconEdit, className, size); }
export function WebuiIconMessageLikeOff({ className, size = 20 }: WebuiSizedIconProps): ReactElement { return glyph(IconThumbUp, className, size); }
export function WebuiIconMessageLikeOn({ className, size = 20 }: WebuiSizedIconProps): ReactElement { return glyph(IconThumbUp, className, size); }
export function WebuiIconMessageDislikeOff({ className, size = 20 }: WebuiSizedIconProps): ReactElement { return glyph(IconThumbDown, className, size); }
export function WebuiIconMessageDislikeOn({ className, size = 20 }: WebuiSizedIconProps): ReactElement { return glyph(IconThumbDown, className, size); }
export function WebuiIconMessageFork({ className, size = 20 }: WebuiSizedIconProps): ReactElement { return glyph(IconGitFork, className, size); }
