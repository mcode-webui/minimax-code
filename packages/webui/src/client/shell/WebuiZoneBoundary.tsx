import type { ReactNode } from "react";

import { WebuiErrorBoundary } from "./WebuiErrorBoundary.js";

/**
 * The zones whose failure is recoverable on its own.
 *
 * The root boundary still exists and still catches whatever escapes these, but a
 * Workspace panel that throws must not take the composer, the transcript and the
 * rail with it: losing an unsent draft because a file tree failed to render is
 * the failure this exists to prevent.
 */
export type WebuiErrorZone =
  | "composer"
  | "transcript"
  | "workspace"
  | "plugins"
  | "settings"
  | "review"
  | "scheduling";

const COPY: Readonly<Record<WebuiErrorZone, { readonly title: string; readonly detail: string }>> = {
  composer: {
    title: "输入区出现错误",
    detail: "输入区未能正常显示。应用已保留其余状态，可以重试恢复。",
  },
  transcript: {
    title: "对话记录出现错误",
    detail: "对话记录未能正常显示。应用已保留其余状态，可以重试恢复。",
  },
  workspace: {
    title: "工作区面板出现错误",
    detail: "工作区面板未能正常显示。应用已保留其余状态，可以重试恢复。",
  },
  plugins: {
    title: "插件管理出现错误",
    detail: "插件管理未能正常显示。应用已保留其余状态，可以重试恢复。",
  },
  settings: {
    title: "设置出现错误",
    detail: "设置未能正常显示。应用已保留其余状态，可以重试恢复。",
  },
  review: {
    title: "审查模式出现错误",
    detail: "审查模式未能正常显示。应用已保留其余状态，可以重试恢复。",
  },
  scheduling: {
    title: "定时任务出现错误",
    detail: "定时任务面板未能正常显示。其他状态已保留，可以重试恢复。",
  },
};

/**
 * One zone's recovery boundary.
 *
 * Deliberately thin: the recovery contract is the root boundary's, reused rather
 * than reimplemented, so a zone retry and an app retry behave the same way and
 * there is only one place that decides what "retry" means. What this adds is the
 * *scope* — the boundary holds the throw here, so the sibling zones never see it.
 *
 * `onReset` is forwarded because a zone usually wants to re-run its own read on
 * retry; the children remount either way, which is what re-establishes their
 * effects.
 */
export function WebuiZoneBoundary({
  zone,
  children,
  onReset,
}: {
  readonly zone: WebuiErrorZone;
  readonly children: ReactNode;
  readonly onReset?: () => void;
}): ReactNode {
  return (
    <WebuiErrorBoundary
      title={COPY[zone].title}
      detail={COPY[zone].detail}
      presentation="panel"
      {...(onReset ? { onReset } : {})}
    >
      {children}
    </WebuiErrorBoundary>
  );
}
