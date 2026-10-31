// The rail's context menu, declared once.
//
// The rule is which items the rail offers, in what order, with which label and which
// subject they belong to; the builders were `openSessionMenu`'s two tables and
// `openProjectMenu`'s one. This module is that rule, and nothing else: it is
// React-free, so it cannot hold an icon, and the host maps each `key` to its icon
// and its wiring through one branch. A registry may carry a host render branch,
// which is what keeps this module free of JSX.

/** Which subject a menu is opened for. */
export type WebuiRailMenuSubject = "session" | "child-session" | "project";

/** The state a label may depend on. */
export interface WebuiRailMenuState {
  readonly pinned: boolean;
  readonly archived: boolean;
}

export interface WebuiRailMenuEntry {
  readonly kind: "item" | "divider";
  /**
   * The item's identity, and the host's wiring key. A `divider` carries one so the
   * React key is stable, but no host branch exists for it.
   */
  readonly key: string;
  /** Absent on a divider. A function resolves against `WebuiRailMenuState`. */
  readonly label?: string | ((state: WebuiRailMenuState) => string);
  readonly danger?: boolean;
  /**
   * Declared but unwired on this client. The host
   * renders it disabled, and that is a property of the declaration rather than of
   * a missing prop: an item that exists and cannot run says so here.
   */
  readonly unwired?: boolean;
  readonly submenu?: readonly WebuiRailMenuEntry[];
}

/**
 * The menu, per subject. Order is the render order, dividers included, which is
 * why the dividers are entries rather than separators the host inserts.
 */
export const WEBUI_RAIL_MENU: Readonly<Record<WebuiRailMenuSubject, readonly WebuiRailMenuEntry[]>> = {
  "child-session": [
    { kind: "item", key: "rename", label: "重命名" },
    { kind: "item", key: "export", label: "导出会话" },
    { kind: "item", key: "copy-session-id", label: "复制会话 ID" },
    { kind: "item", key: "delete", label: "删除", danger: true },
  ],
  session: [
    { kind: "item", key: "rename", label: "重命名" },
    { kind: "item", key: "archive", label: (state) => (state.archived ? "取消归档" : "归档") },
    { kind: "divider", key: "fork-divider" },
    { kind: "item", key: "fork-current", label: "复制为新会话" },
    { kind: "item", key: "fork-worktree", label: "复制到新工作树" },
    { kind: "divider", key: "copy-divider" },
    { kind: "item", key: "show-folder", label: "在文件夹中显示", unwired: true },
    {
      kind: "item",
      key: "copy",
      label: "复制",
      submenu: [
        { kind: "item", key: "copy-workspace-dir", label: "复制工作目录" },
        { kind: "item", key: "copy-session-id", label: "复制会话 ID" },
      ],
    },
    { kind: "item", key: "export", label: "导出会话" },
    { kind: "item", key: "feedback", label: "问题反馈", unwired: true },
    { kind: "divider", key: "delete-divider" },
    { kind: "item", key: "delete", label: "删除", danger: true },
  ],
  project: [
    { kind: "item", key: "rename-project", label: "重命名项目" },
    {
      kind: "item",
      key: "toggle-pin-project",
      label: (state) => (state.pinned ? "取消置顶项目" : "置顶项目"),
    },
    { kind: "item", key: "show-project-in-folder", label: "在文件夹中显示", unwired: true },
    { kind: "item", key: "archive-project-sessions", label: "归档对话" },
    { kind: "item", key: "remove-project", label: "移除", danger: true, unwired: true },
  ],
};

/** Every item key the registry declares, divider keys excluded. */
export function webuiRailMenuKeys(): readonly string[] {
  const keys: string[] = [];
  const walk = (entries: readonly WebuiRailMenuEntry[]): void => {
    for (const entry of entries) {
      if (entry.kind === "divider") continue;
      keys.push(entry.key);
      if (entry.submenu) walk(entry.submenu);
    }
  };
  for (const subject of Object.keys(WEBUI_RAIL_MENU) as WebuiRailMenuSubject[]) {
    walk(WEBUI_RAIL_MENU[subject]);
  }
  return [...new Set(keys)];
}

/**
 * One subject's entries with their labels resolved. A copy, so a caller cannot
 * reach back into the table through the submenu arrays.
 */
export function webuiRailMenuFor(
  subject: WebuiRailMenuSubject,
  state: WebuiRailMenuState,
): readonly WebuiRailMenuEntry[] {
  const resolve = (entry: WebuiRailMenuEntry): WebuiRailMenuEntry => ({
    ...entry,
    ...(typeof entry.label === "function" ? { label: entry.label(state) } : {}),
    ...(entry.submenu ? { submenu: entry.submenu.map(resolve) } : {}),
  });
  return WEBUI_RAIL_MENU[subject].map(resolve);
}
