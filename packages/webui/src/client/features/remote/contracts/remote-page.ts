// The 远程 page's tab model.
//
// Two tabs, transcribed from the Desktop's remote page (the renderer's
// `desktop-mobile-page-tabs` radiogroup): 远程控制 and 接入 IM. The values are
// the Desktop's own (`remote-control`, `im-connect`), so a report that names a
// tab names the same tab on both clients.

/** The 远程 page's two tabs. */
export type WebuiRemoteTabValue = "remote-control" | "im-connect";

export interface WebuiRemoteTab {
  readonly value: WebuiRemoteTabValue;
  readonly label: string;
}

/**
 * The tab strip, in the Desktop's order.
 *
 * The Desktop's copy comes from the renderer's i18n catalogue
 * (`sidebar.remote_control` and `sidebar.desktop_connect_im`); the words are
 * the Desktop's, not invented here.
 */
export const WEBUI_REMOTE_TABS: readonly WebuiRemoteTab[] = [
  { value: "remote-control", label: "远程控制" },
  { value: "im-connect", label: "接入 IM" },
];

/** The tab the page opens on: the pairing page, as on the Desktop. */
export const WEBUI_REMOTE_DEFAULT_TAB: WebuiRemoteTabValue = "remote-control";
