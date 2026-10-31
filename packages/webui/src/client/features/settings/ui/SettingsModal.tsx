// Settings Modal — the private slices that stay inside the settings business.
//
// `SettingsModal` itself is published as `./SettingsModal.public.tsx` because
// the account business mounts the dialog from `account/ui/UserMenu.tsx`. What
// stays here is the rest of the settings surface: the icon glyph set the
// navigation sidebar reads, the small set of generic-layout row/section
// constants the in-modal pages consume, and the worktree panel the page tests
// assert on. None of these are consumed by another business, so they stay
// alongside the implementation in the private sibling.

import type { ReactElement } from "react";
import {
  selectWebuiPrimaryWorkspace,
  selectWebuiWorktreeWorkspaces,
  type WebuiWorktreeWorkspace,
} from "../../../features/sessions/projection/worktree-state.public.js";
import { FolderIcon } from "../../../ui/settings-glyphs.js";
import { SettingsPage, SettingsRow, SettingsSection } from "../../../ui/settings-layout.js";
import { FeedbackError } from "../../../ui/feedback.js";

import { FeedbackEmpty } from "../../../ui/feedback.js";
export { SETTINGS_GROUPS } from "../projection/settings-view.js";

export const SETTINGS_ICON_PATHS = { desktop: "M14.9996 3.56689H4.99963C3.747 3.56689 2.73303 4.581 2.73303 5.8335V12.938L1.7301 15.189C1.61993 15.408 1.66322 16.3808 2.31799 17.0884H16.983C18.3361 16.3808 18.3787 15.4072 18.2682 15.188L17.2662 12.938V5.8335C17.2662 4.581 16.2522 3.56689 14.9996 3.56689Z", browser: "M3.33333 4.16667H16.6667C17.2204 4.16667 17.6667 4.61295 17.6667 5.16667V14.8333C17.6667 15.387 17.2204 15.8333 16.6667 15.8333H3.33333C2.77964 15.8333 2.33333 15.387 2.33333 14.8333V5.16667C2.33333 4.61295 2.77964 4.16667 3.33333 4.16667ZM2.33333 8.33333H17.6667M5 6.25H5.01M6.91667 6.25H6.92667", voice: "M11.25 4.25C11.25 3.00736 10.2426 2 9 2C7.75736 2 6.75 3.00736 6.75 4.25V9.5C6.75 10.7426 7.75736 11.75 9 11.75C10.2426 11.75 11.25 10.7426 11.25 9.5V4.25ZM14.25 7.5V9C14.25 11.8995 11.8995 14.25 9 14.25C6.10051 14.25 3.75 11.8995 3.75 9V7.5M9 14.25V16.5M6.75 16.5H11.25", shortcuts: "M13.8768 13.1403H6.10529M2 5.59998C2 4.49541 2.89543 3.59998 4 3.59998H16C17.1046 3.59998 18 4.49541 18 5.59998V14.4C18 15.5045 17.1046 16.4 16 16.4H4C2.89543 16.4 2 15.5045 2 14.4V5.59998Z", "custom-instructions": "M5.24316 2.84784C5.24316 1.57385 6.64787 .800013 7.72461 1.48065L9.60449 3.33514L10.5469 4.78241L11.4404 4.40253C12.9336 3.47824 14.6993 3.09444 16.4414 3.31561V14.6672C14.7097 14.609 13.1971 14.3609 11.873 15.1232L10.2988 16.0295L9.25098 15.7307C7.60003 14.6279 5.89805 14.1654 4.07324 14.3644V4.47479Z", chart: "M2.86194 2.26236V15.5514C2.86194 16.0953 3.30396 16.5368 3.84788 16.5368H17.1373M6.82776 9.53873V13.9655M10.7926 4.44888V13.9655M14.7584 7.62076V13.9655", link: "M10.0002 1.97192A8.0283 8.0283 0 1 0 10.0002 18.0286A8.0283 8.0283 0 0 0 10.0002 1.97192ZM3.19849 10.5999H16.801", user: "M6.25 16.4965V15.25C6.25 14.8522 6.40804 14.4706 7.75 13.75H12.25C13.75 14.8522 13.592 14.4706 13.75 15.25V16.4965M17.5 10A7.5 7.5 0 1 1 2.5 10A7.5 7.5 0 0 1 17.5 10Z", coding: "M11.7852 3.57383L8.34082 16.4264M5.14453 5.74961L1.42969 9.46347L5.99219 14.027M14.0078 5.74961L18.5703 9.46347L14.0078 14.027", worktree: "M11.1538 1.82715V5.42676H10.7524V9.33691H13.9868C15.4225 9.33726 16.5864 10.5008 16.5864 11.9365V12.9736", work: "M7.33333 2.66667H12.6667C15.9804 2.66667 18.6667 5.35296 18.6667 8.66667C18.6667 11.9804 15.9804 14.6667 12.6667 14.6667H8.66667L4 18V14.1141C2.77778 13.0222 2 11.4259 2 9.66667C2 5.8 4.61111 2.66667 7.33333 2.66667Z", archived: "M16.0669 3.6062H3.13232C2.12081 3.6062 1.30127 4.42602 1.30127 5.43726V6.05347C1.30127 7.06489 2.12081 7.8855 3.13232 7.8855H16.0669V14.7683C16.0669 16.2334 14.657 17.4216 13.1919 17.4216H6.00635C4.54129 17.4216 3.354 16.2334 3.354 14.7683V7.8855", search: "m21 21-4.3-4.3M10.8 18a7.2 7.2 0 1 1 0-14.4 7.2 7.2 0 0 1 0 14.4", close: "M6 6l12 12M18 6 6 18", back: "M9.57617 3.74332C9.81049 3.509 10.1905 3.509 10.4248 3.74332L3.74219 9.57632L9.57617 16.258C10.1906 16.492 10.1906 16.492 10.4248 16.258L5.61426 10.5998H15.834C16.165 10.5998 16.4336 10.3312 16.4336 10.0002C16.4336 9.66901 16.165 9.40092 15.834 9.40054H5.61426Z" } as const;
export const GENERIC_SECTION_TEST_IDS = ["app-mode-section", "application-section", "link-open-destination-section", "file-section", "session-management-section", "agent-control-permission-section", "about-section"] as const;
export const GENERIC_RADIO_CONTRACT = { position: "absolute right-4 top-[22px]", accentToken: "icon_default_accent" } as const;
export const GENERIC_FILE_ROW_ORDER = ["file-open-in-new-tab-switch", "file-line-wrap-switch"] as const;

/** Presentational half of the worktree page. The page that fetches and groups
 *  the sessions lives in `SettingsModal.public.tsx` next to the dialog; the
 *  panel itself stays here as a renderable artefact the page tests assert on
 *  via static markup. */
export function WebuiWorktreePanel({ workspaces, worktrees, primary, error }: {
  readonly workspaces: readonly WebuiWorktreeWorkspace[];
  readonly worktrees?: readonly WebuiWorktreeWorkspace[];
  readonly primary?: WebuiWorktreeWorkspace;
  readonly error?: string;
}): ReactElement {
  const branches = worktrees ?? selectWebuiWorktreeWorkspaces(workspaces);
  const main = primary ?? selectWebuiPrimaryWorkspace(workspaces);
  // The page renders the shared settings skeleton: the same frame, the same
  // section title and the same card of rows every other settings page uses.
  // What a row carries inside it — the session list — is this page's own
  // content and keeps its own rules.
  return <SettingsPage testId="settings-worktree-page" dataAttributes={{ "data-webui-worktree-state": error ? "error" : branches.length ? "ready" : "empty" }}>
    {error ? <FeedbackError message={error} className="webui-review-error" testId="worktree-error" /> : null}
    {main ? <SettingsSection title="工作区" testId="worktree-primary-section">
      <SettingsRow
        title={<><FolderIcon />{main.name}</>}
        description={main.workspaceDir}
        testId="worktree-primary"
        dataAttributes={{ "data-webui-worktree-primary": "true" }}
        body={<ul className="webui-worktree-sessions">
          {main.sessions.map((entry) => <li className="webui-worktree-session" key={entry.sessionId} data-testid="worktree-session">
            <span className="webui-worktree-session-title" title={entry.title}>{entry.title}</span>
          </li>)}
        </ul>}
      >
        <span className="webui-worktree-kind">主检出</span>
      </SettingsRow>
    </SettingsSection> : null}
    <SettingsSection title="并行实验分支" testId="worktree-branches-section">
      {branches.length === 0 ? <FeedbackEmpty className="webui-review-empty" title="还没有工作树。在会话的右键菜单里选「复制到新工作树」即可开一个。" testId="worktree-empty" /> : branches.map((branch) => <SettingsRow
        key={branch.workspaceDir}
        title={<><FolderIcon />{branch.name}</>}
        description={branch.workspaceDir}
        testId="worktree-branch"
        dataAttributes={{ "data-webui-worktree-dir": branch.workspaceDir }}
        body={<ul className="webui-worktree-sessions">
          {branch.sessions.map((entry) => <li className="webui-worktree-session" key={entry.sessionId} data-testid="worktree-session" data-webui-worktree-session={entry.sessionId}>
            {/* Session navigation in this shell is the `#session=<id>` hash,
                which is what the rail's own links use. Reusing it keeps one
                navigation path instead of adding a second one. */}
            <a className="webui-worktree-session-link" href={`#session=${entry.sessionId}`} title={entry.title}>{entry.title}</a>
            {entry.parentSessionId ? <span className="webui-worktree-forked" title={`派生自 ${entry.parentSessionId}`}>派生</span> : null}
          </li>)}
        </ul>}
      >
        <span className="webui-worktree-kind">{branch.sessions.length} 个会话</span>
      </SettingsRow>)}
    </SettingsSection>
  </SettingsPage>;
}
