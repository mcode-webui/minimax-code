// The home composer's project row and its native folder chooser.
//
// This was the tail of the `WebuiComposer` render. It is the unit that
// carries where the composer sits on the home surface: the row lives INSIDE the
// scrim container rather than beside it, because `.message-input-home-container`
// is the light surface that already wraps the card — sharing that box is what
// makes the card and the band one continuous surface instead of two stacked
// boxes meeting along a seam.
//
// The shell owns the recent menu's open state. The row owns its pending
// native chooser.

import { useEffect, useRef } from "react";

import { WebuiDropdown } from "../../../ui/Dropdown.js";
import { WebuiButton } from "../../../ui/button.js";
import { useWebuiToast } from "../../../ui/toast.js";
import { useWebuiBrowserCapabilities } from "../../../bindings/browser-capabilities.js";
import { workspaceProjectName } from "../../../features/workspace/projection/workspace-name.public.js";
import { WebuiIconCheck, WebuiIconFolder } from "../../../shell/icons.js";

export interface WebuiComposerProjectRowProps {
  /** The directory the next session would use, or `undefined` for none. */
  readonly projectDir: string | undefined;
  /** Directories offered as `最近`, newest first. */
  readonly recentDirs: readonly string[];
  /** Whether this row's menu is open. The shell owns the cell. */
  readonly menuOpen: boolean;
  readonly onMenuOpenChange: (open: boolean) => void;
  /** The chosen directory; `undefined` means "不需要项目". */
  readonly onSelectProject: (dir: string | undefined) => void;
}

export function WebuiComposerProjectRow({
  projectDir,
  recentDirs,
  menuOpen,
  onMenuOpenChange,
  onSelectProject,
}: WebuiComposerProjectRowProps) {
  const { nativeDirectoryPicker } = useWebuiBrowserCapabilities();
  const { show } = useWebuiToast();
  const request = useRef<AbortController | null>(null);
  useEffect(() => () => request.current?.abort(), []);

  function selectProject(dir: string | undefined) {
    // The browser stays interactive while the independent OS window is open.
    // A later choice from the menu takes precedence over its eventual result.
    request.current?.abort();
    request.current = null;
    onSelectProject(dir);
  }

  async function chooseNewProject() {
    onMenuOpenChange(false);
    if (request.current) return;
    const current = new AbortController();
    request.current = current;
    try {
      const result = await nativeDirectoryPicker?.choose(current.signal);
      if (current.signal.aborted) return;
      if (!result || result.kind === "unavailable") {
        show({ tone: "error", message: "系统文件夹选择器不可用，请在运行 WebUI 的电脑上通过 mcode-webui 启动器打开页面。" });
      } else if (result.kind === "selected") {
        onSelectProject(result.directory);
      }
    } catch (error) {
      if (!current.signal.aborted) {
        show({ tone: "error", message: error instanceof Error && !(error instanceof TypeError)
          ? error.message
          : "无法打开系统文件夹选择器，请重试。" });
      }
    } finally {
      if (request.current === current) request.current = null;
    }
  }

  return (
    <div className="webui-workspace-bar" data-webui-workspace-toolbar="true">
      <div className="relative">
        <WebuiDropdown
          managed
          managedLayerId="composer-project-row"
          open={menuOpen}
          onOpen={() => onMenuOpenChange(true)}
          onClose={() => onMenuOpenChange(false)}
          role="listbox"
          ariaLabel="工作目录"
          align="start"
          // The row sits in the middle of the composer, and the list is taller
          // than the space below it on a short window: opened downwards it ran
          // off the bottom of the screen with its last rows unreachable. It
          // opens upwards, and the clamp keeps it inside the viewport when
          // even upwards does not fit.
          side="top"
          collision="clamp"
          wrapperClassName="webui-workspace-picker"
          className="webui-workspace-picker-menu"
          trigger={(triggerProps) => (
            <WebuiButton variant="plain" size="compact"
              type="button"
              {...triggerProps}
              data-webui-workspace-picker="true"
              className="webui-workspace-bar-trigger"
            >
              <span className="flex size-5 shrink-0 items-center justify-center">
                <WebuiIconFolder />
              </span>
              <span className="min-w-0 flex-1 truncate whitespace-nowrap leading-5">
                {projectDir ? workspaceProjectName(projectDir) : "选择文件夹"}
              </span>
            </WebuiButton>
          )}
        >
          {/* A `最近` group of workspaces the user has actually
           * been in, a rule, then the two commands. The group is omitted
           * entirely when there is no history — an empty `最近` header above a
           * divider reads as a broken panel. */}
          {recentDirs.length > 0 ? (
            <>
              <div className="webui-workspace-menu-header" aria-hidden="true">
                最近
              </div>
              {recentDirs.map((dir) => {
                const active = dir === projectDir;
                return (
                  <WebuiButton variant="plain" size="regular"
                    key={dir}
                    type="button"
                    role="option"
                    aria-selected={active}
                    data-webui-workspace-recent={dir}
                    className="webui-workspace-option"
                    title={dir}
                    onClick={() => selectProject(dir)}
                  >
                    <WebuiIconFolder className="flex-shrink-0" />
                    <span className="min-w-0 flex-1 truncate text-left">
                      {workspaceProjectName(dir)}
                    </span>
                    {active ? <WebuiIconCheck className="webui-workspace-option-check" /> : null}
                  </WebuiButton>
                );
              })}
              <div className="webui-workspace-menu-separator" role="separator" />
            </>
          ) : null}
          <WebuiButton variant="plain" size="regular"
            type="button"
            role="option"
            aria-selected={false}
            data-webui-workspace-action="add-new"
            className="webui-workspace-option"
            onClick={() => void chooseNewProject()}
          >
            <WebuiIconFolder className="flex-shrink-0" />
            <span className="min-w-0 flex-1 truncate text-left">
              选择新项目
            </span>
          </WebuiButton>
          <WebuiButton variant="plain" size="regular"
            type="button"
            role="option"
            aria-selected={projectDir === undefined}
            data-webui-workspace-action="no-project"
            className="webui-workspace-option"
            onClick={() => selectProject(undefined)}
          >
            <WebuiIconFolder className="flex-shrink-0" />
            <span className="min-w-0 flex-1 truncate text-left">
              不需要项目
            </span>
          </WebuiButton>
        </WebuiDropdown>
      </div>
    </div>
  );
}
