// The workspace directory browser.
//
// The picker the composer opens for a working directory: it lists a directory, walks up and down,
// accepts a typed absolute path, and hands the chosen directory back. It owns its listing, loading and
// error state; the composer owns the open/closed flag and the value, and passes the browse command in.


import { WebuiIconFolder } from "../../../shell/icons.js";
import type { WebuiWorkspaceDirectoryListing } from "../../../../shared/contracts/workspace.js";
import { looksLikeAbsoluteWorkspacePath } from "../../../projection/common/paths.js";
import { useCallback, useEffect, useState, type ReactElement } from "react";
import { FeedbackError } from "../../../ui/feedback.js";
import { WebuiButton } from "../../../ui/button.js";
import { WebuiField, WebuiTextInput } from "../../../ui/field.js";
import { WebuiInline, WebuiStack } from "../../../ui/layout-primitives.js";
import { FeedbackEmpty } from "../../../ui/feedback.js";
import {
  useWebuiWorkspaceFiles,
  useWebuiWorkspaceQueriesState,
} from "../../../bindings/use-query-state.js";

export function WebuiWorkspaceDirectoryBrowser({
  initialDir,
  onSelect,
  onCancel,
}: {
  readonly initialDir?: string;
  readonly onSelect: (dir: string) => void;
  readonly onCancel: () => void;
}): ReactElement {
  // The listing, its freshness and its failure belong to the files owner:
  // a browse that answers after a newer one is dropped there, so fast navigation
  // cannot show the wrong directory. This component keeps the typed draft and the
  // geometry.
  const queries = useWebuiWorkspaceFiles();
  const browseState = useWebuiWorkspaceQueriesState().directoryBrowse;
  const listing = browseState.status === "ready" ? browseState.listing : undefined;
  const loading = browseState.status === "loading";
  const [localError, setLocalError] = useState<string>();
  const error = browseState.status === "error" ? browseState.error : localError;
  const [manualPath, setManualPath] = useState(initialDir ?? "");

  const browse = useCallback(
    (dir?: string) => {
      queries?.browseWorkspaceDirs(dir);
    },
    [queries],
  );

  useEffect(() => {
    browse(initialDir);
  }, [browse, initialDir]);
  // A listing that lands seeds the typed path, so the field shows where the user is.
  useEffect(() => {
    if (listing) setManualPath(listing.dir);
  }, [listing]);

  const submitManualPath = useCallback(() => {
    const value = manualPath.trim();
    if (!value) {
      setLocalError("请输入项目目录的绝对路径");
      return;
    }
    if (!looksLikeAbsoluteWorkspacePath(value)) {
      setLocalError("需要绝对路径，例如 /home/you/projects/my-project");
      return;
    }
    onSelect(value);
  }, [manualPath, onSelect]);

  if (!queries?.canBrowseWorkspaceDirs)
    return (
      <WebuiStack gap="small" data-webui-workspace-manual="true">
        <WebuiField
          className="webui-commit-dialog-label"
          label="项目绝对路径"
          control={(props) => (
            <WebuiTextInput
              {...props}
              className="w-full"
              controlSize="compact"
              value={manualPath}
              autoFocus
              placeholder="/home/you/projects/my-project"
              onChange={(event) => {
                setManualPath(event.target.value);
                setLocalError(undefined);
              }}
              onKeyDown={(event) => {
                if (event.key !== "Enter") return;
                event.preventDefault();
                submitManualPath();
              }}
            />
          )}
        />
        {error ? (
          <FeedbackError message={error} className="webui-commit-dialog-error" />
        ) : null}
        <div className="webui-workspace-browser-actions">
          <WebuiButton
            variant="outline"
            size="compact"
            type="button"
            onClick={onCancel}
          >
            取消
          </WebuiButton>
          <WebuiButton
            variant="accent"
            size="compact"
            type="button"
            onClick={submitManualPath}
          >
            使用此目录
          </WebuiButton>
        </div>
      </WebuiStack>
    );

  return (
    <WebuiStack gap="small" data-webui-workspace-browser="true">
      <WebuiInline gap="small">
        {listing?.parent ? (
          <WebuiButton
            variant="plain"
            size="compact"
            type="button"
            className="webui-workspace-option webui-workspace-option--desktop"
            data-webui-workspace-action="up"
            onClick={() => browse(listing.parent)}
          >
            <span className="min-w-0 flex-1 truncate text-left">上一级</span>
          </WebuiButton>
        ) : null}
        <span
          className="min-w-0 flex-1 truncate text-text_default_secondary text-size_12"
        >
          {listing?.dir ?? "正在读取目录…"}
        </span>
      </WebuiInline>
      {error ? (
        <FeedbackError message={error} className="webui-commit-dialog-error" />
      ) : null}
      {loading ? (
        <FeedbackEmpty className="webui-composer-menu-empty" title={"正在读取目录…"} />
      ) : listing?.entries.length ? (
        listing.entries.map((entry) => (
          <WebuiButton
            variant="plain"
            size="regular"
            key={entry.path}
            type="button"
            className="webui-workspace-option webui-workspace-option--desktop"
            data-webui-workspace-action="enter"
            onClick={() => browse(entry.path)}
          >
            <WebuiIconFolder className="flex-shrink-0" />
            <span className="min-w-0 flex-1 truncate text-left">
              {entry.name}
            </span>
          </WebuiButton>
        ))
      ) : (
        <FeedbackEmpty className="webui-composer-menu-empty" title={"此目录下没有子目录"} />
      )}
      {listing?.truncated ? (
        <FeedbackEmpty className="webui-composer-menu-empty" title={"子目录过多，仅显示前若干项"} />
      ) : null}
      <div className="webui-workspace-browser-actions">
        <WebuiButton
          variant="outline"
          size="compact"
          type="button"
          onClick={onCancel}
        >
          取消
        </WebuiButton>
        <WebuiButton
          variant="accent"
          size="compact"
          type="button"
          disabled={!listing}
          onClick={() => {
            if (listing) onSelect(listing.dir);
          }}
        >
          使用此目录
        </WebuiButton>
      </div>
    </WebuiStack>
  );
}

/** What the retry affordance on a failed turn should do. */
