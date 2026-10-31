import type { ReactElement } from "react";
import { IconBrowser, IconLayoutSidebarRightCollapse } from "@tabler/icons-react";
import { WebuiIconButton } from "../../../ui/button.js";

/** Entry controls for the independent workspace and progress panels. */
export function WebuiWorkspacePanelControls({ browserPanelOpen, progressPanelOpen, progressPanelAvailable = true, onOpenBrowser, onToggleProgressPanel }: {
  readonly browserPanelOpen: boolean;
  readonly progressPanelOpen: boolean;
  /**
   * Whether the window is wide enough for the progress panel to be open.
   *
   * Below the contract's width the card would sit on the conversation's text, so
   * the panel closes itself. The control says so rather than pretending to work:
   * it keeps its place in the row, keeps its accessible name, and explains
   * itself.
   */
  readonly progressPanelAvailable?: boolean;
  readonly onOpenBrowser: () => void;
  readonly onToggleProgressPanel: () => void;
}): ReactElement {
  return <div className="webui-workspace-panel-controls" data-testid="workspace-panel-controls">
    <WebuiIconButton tone="bare" size="panel" label="浏览器" aria-pressed={browserPanelOpen} onClick={onOpenBrowser}><IconBrowser className="size-5" stroke={1.6} aria-hidden="true" /></WebuiIconButton>
    <WebuiIconButton
      tone="bare"
      size="panel"
      label="环境信息与进度"
      data-webui-progress-toggle="true"
      aria-pressed={progressPanelOpen}
      aria-disabled={progressPanelAvailable ? undefined : "true"}
      title={progressPanelAvailable ? undefined : "窗口宽度不足，进度面板已收起"}
      onClick={onToggleProgressPanel}
    ><IconLayoutSidebarRightCollapse className="size-5" stroke={1.6} aria-hidden="true" /></WebuiIconButton>
  </div>;
}
