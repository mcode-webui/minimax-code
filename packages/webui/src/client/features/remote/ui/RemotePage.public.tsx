// The 远程 page: the two-tab switcher the Desktop's remote page shows.
//
// Transcribed from the live Desktop (`desktop-mobile-page-tabs` in the renderer
// bundle; measured with `getComputedStyle` on the running Desktop):
//
//   header   `flex h-[46px] min-w-0 shrink-0 items-center justify-between gap-3 py-2 pr-2
//            transition-[padding] duration-200 ease-in-out pl-2`   → 46px tall, 8px pad, 12px gap
//   group    `no-scrollbar flex min-w-0 overflow-x-auto`             → 30px tall
//   item     `h-7 items-center justify-center rounded-[6px] px-3 text-[14px] leading-5
//            transition-colors`                                     → 26px tall, 6px radius
//   selected `bg-bg_grouped_secondary_elevated font-medium text-text_default_primary`
//   plain    `font-normal text-text_default_secondary hover:text-text_default_primary`
//
// The Desktop's strip is an antd segmented control, so its box-shadow and padding are
// *runtime* styles that never appear in the Desktop's static CSS. The WebUI has no antd, so
// the strip is re-authored here with the WebUI's own tokens and the measured numbers — the
// tokens it reads (`--bg_grouped_secondary_elevated`, `--text_default_primary`,
// `--text_default_secondary`) all exist in `src/client/styles/tokens.css`.
//
// One class is substituted: the Desktop's `no-scrollbar` has no WebUI equivalent, and the
// WebUI's own `scrollbar-hide` is the same intent expressed in its token layer.
//
// The tab bodies are the two businesses' own components. This module does not import them:
// the shell supplies them, so a tab's body is that business's published surface and the
// switcher stays a switcher.
import { useSyncExternalStore, type ReactElement, type ReactNode } from "react";

import {
  WEBUI_REMOTE_TABS,
  type WebuiRemoteTabValue,
} from "../contracts/remote-page.js";
import {
  webuiRemoteTabLabel,
  type WebuiRemoteOwner,
  type WebuiRemoteSnapshot,
} from "../application/remote-owner.js";

export interface RemotePageViewProps {
  readonly activeTab: WebuiRemoteTabValue;
  readonly onSelectTab: (value: WebuiRemoteTabValue) => void;
  /** The body of the tab that is showing. */
  readonly children: ReactNode;
}

/**
 * The pure render of the page.
 *
 * Separate from the wrapper so the markup is assertable with `renderToStaticMarkup` — this
 * package has no jsdom.
 */
export function RemotePageView({
  activeTab,
  onSelectTab,
  children,
}: RemotePageViewProps): ReactElement {
  return (
    <section
      aria-label="远程"
      data-webui-component="remote-page"
      data-testid="remote-page"
      className="flex h-full min-h-0 min-w-0 flex-1 flex-col bg-bg_default_primary"
    >
      <header
        data-testid="desktop-mobile-page-tabs"
        className="flex h-[46px] min-w-0 shrink-0 items-center justify-between gap-3 py-2 pr-2 pl-2 transition-[padding] duration-200 ease-in-out"
      >
        {/*
          The Desktop's strip is a radiogroup, not a tablist: the segmented control's items are
          radio inputs, so `role="radiogroup"` with `aria-checked` is the faithful shape and the
          screen reader announces "1 of 2" the way it does on the Desktop.
        */}
        <div
          role="radiogroup"
          aria-label="远程"
          data-testid="remote-page-tabs"
          className="scrollbar-hide flex min-w-0 overflow-x-auto"
        >
          {WEBUI_REMOTE_TABS.map((tab) => {
            const selected = tab.value === activeTab;
            return (
              <label
                key={tab.value}
                className={`flex h-7 cursor-pointer items-center justify-center rounded-[6px] px-3 text-[14px] leading-5 transition-colors ${
                  selected
                    ? "bg-bg_grouped_secondary_elevated font-medium text-text_default_primary"
                    : "font-normal text-text_default_secondary hover:text-text_default_primary"
                }`}
                data-testid={`remote-page-tab-${tab.value}`}
                data-selected={selected ? "true" : "false"}
              >
                <input
                  type="radio"
                  name="webui-remote-page-tabs"
                  className="sr-only"
                  checked={selected}
                  onChange={() => onSelectTab(tab.value)}
                />
                <span title={tab.label}>{tab.label}</span>
              </label>
            );
          })}
        </div>
      </header>
      <div className="min-h-0 flex-1">{children}</div>
    </section>
  );
}

export interface RemotePageProps {
  readonly owner: WebuiRemoteOwner;
  /** The body of the page, for the state the owner is in. */
  readonly render: (snapshot: WebuiRemoteSnapshot) => ReactNode;
}

/**
 * The page: the switcher, subscribed to its owner.
 *
 * The owner holds the two facts the page needs — which tab is showing, and
 * whether the SSH surface has taken the body. The two tab bodies keep their own
 * state; the switcher does not own them.
 */
export function RemotePage({ owner, render }: RemotePageProps): ReactElement {
  const snapshot = useSyncExternalStore(
    owner.subscribe,
    owner.getSnapshot,
    owner.getSnapshot,
  );
  return (
    <RemotePageView
      activeTab={snapshot.activeTab}
      onSelectTab={(value) => owner.selectTab(value)}
    >
      {render(snapshot)}
    </RemotePageView>
  );
}

export { webuiRemoteTabLabel };
