// Which surface the main column shows.
//
// Plugin management is a *replacement*, not a layer: the shell renders it
// instead of the home hero / session transcript, while the rail stays live on
// its left. That makes the rail the only way back, so every conversation
// navigation — a session link, 「新建任务」, a session the composer just created
// — has to leave the plugin surface. It used to be a bare `useState(false)`
// that only the plugin page's own × button cleared, so a rail click changed
// the selected session invisibly and the user stayed on the marketplace with
// no apparent response.
//
// The rule lives here rather than in the component so it is testable without a
// DOM (see `packages/webui/AGENTS.md` — no jsdom in this package): the shell
// funnels every session change through one setter, and that setter dispatches
// `show-conversation`.

/** Which entry point of plugin management opened it. The component carries
 * more areas (`apps`, `mcp`, `agents`) but only these two are reachable from
 * outside the page, so only these two are part of the shell's own state. */
export type WebuiPluginManagementArea = "plugins" | "skills";

export type WebuiShellSurface =
  | { readonly kind: "conversation" }
  | { readonly kind: "plugin-management"; readonly area: WebuiPluginManagementArea }
  /**
   * The scheduled-task panel (ADR 0027). A surface of its own because scheduled tasks are not
   * session-scoped: it cannot be a tab of the workspace panel or a section of the settings modal,
   * and the rail has to stay live beside it so a session click is the way back out.
   */
  | { readonly kind: "scheduling" };

export type WebuiShellSurfaceCommand =
  | { readonly type: "open-plugin-management"; readonly area: WebuiPluginManagementArea }
  | { readonly type: "close-plugin-management" }
  | { readonly type: "open-scheduling" }
  | { readonly type: "show-conversation" };

export const initialWebuiShellSurface: WebuiShellSurface = { kind: "conversation" };

const conversation: WebuiShellSurface = { kind: "conversation" };

export function reduceWebuiShellSurface(
  state: WebuiShellSurface,
  command: WebuiShellSurfaceCommand,
): WebuiShellSurface {
  switch (command.type) {
    case "open-plugin-management":
      // Re-opening the same area is a no-op, so the state object keeps its
      // identity and React can bail out of the re-render.
      if (state.kind === "plugin-management" && state.area === command.area) return state;
      return { kind: "plugin-management", area: command.area };
    case "open-scheduling":
      return state.kind === "scheduling" ? state : { kind: "scheduling" };
    case "close-plugin-management":
    case "show-conversation":
      // Both collapse to the conversation: closing from the page's × and
      // navigating away from the rail are the same transition as far as the
      // surface is concerned. Returning the shared object keeps identity
      // stable when the surface was already the conversation.
      return state.kind === "conversation" ? state : conversation;
  }
}

export function isSchedulingSurface(surface: WebuiShellSurface): boolean {
  return surface.kind === "scheduling";
}

export function isPluginManagementSurface(surface: WebuiShellSurface): boolean {
  return surface.kind === "plugin-management";
}

/** The area to open the page on, or `undefined` when the conversation is
 * showing. Read with this instead of narrowing at each consumption point. */
export function webuiPluginManagementArea(
  surface: WebuiShellSurface,
): WebuiPluginManagementArea | undefined {
  return surface.kind === "plugin-management" ? surface.area : undefined;
}
