// The shell's main column renders plugin management *instead of* the
// conversation, so the rail is the only way back out of it. The bug this file
// pins: the surface used to be a `useState(false)` that only the plugin page's
// own × button cleared, so clicking a session in the rail changed the selected
// session invisibly and the user stayed on the marketplace — "点击无效" — with
// the rail still lit up as if nothing had happened.
//
// No DOM framework is allowed in this package, so the transitions live in
// `features/shell/projection/shell-surface.ts` and are driven here directly. The wiring that
// the reducer cannot see (the rail anchors resolving through the
// `hashchange` subscription, and the shell effect that watches the selected
// session id) is covered by the source assertions at the bottom.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  initialWebuiShellSurface,
  isPluginManagementSurface,
  isSchedulingSurface,
  reduceWebuiShellSurface,
  webuiPluginManagementArea,
  type WebuiShellSurface,
} from "../../src/client/features/shell/projection/shell-surface.js";

const open = (surface: WebuiShellSurface, area: "plugins" | "skills"): WebuiShellSurface =>
  reduceWebuiShellSurface(surface, { type: "open-plugin-management", area });

describe("shell surface", () => {
  it("starts on the conversation and reports the opened area", () => {
    expect(initialWebuiShellSurface).toEqual({ kind: "conversation" });
    expect(isPluginManagementSurface(initialWebuiShellSurface)).toBe(false);
    expect(webuiPluginManagementArea(initialWebuiShellSurface)).toBeUndefined();

    const surface = open(initialWebuiShellSurface, "skills");
    expect(isPluginManagementSurface(surface)).toBe(true);
    expect(webuiPluginManagementArea(surface)).toBe("skills");
  });

  it("carries the area the caller asked for, and switches it on re-entry", () => {
    // The composer's 「管理技能」 and the rail's 插件 row are different entry
    // points into the same page; reopening must not leave the previous area up.
    expect(webuiPluginManagementArea(open(open(initialWebuiShellSurface, "skills"), "plugins"))).toBe(
      "plugins",
    );
  });

  it("returns to the conversation on any session navigation", () => {
    const fromPlugins = open(initialWebuiShellSurface, "plugins");
    expect(reduceWebuiShellSurface(fromPlugins, { type: "show-conversation" })).toEqual({
      kind: "conversation",
    });
    expect(reduceWebuiShellSurface(open(initialWebuiShellSurface, "skills"), { type: "show-conversation" })).toEqual({
      kind: "conversation",
    });
    // Closing from the page's × button and navigating away from the rail are the
    // same transition, so the × cannot be the only exit any more.
    expect(reduceWebuiShellSurface(fromPlugins, { type: "close-plugin-management" })).toEqual({
      kind: "conversation",
    });
  });

  it("keeps state identity when nothing changed, so opening costs one render", () => {
    const surface = open(initialWebuiShellSurface, "plugins");
    expect(open(surface, "plugins")).toBe(surface);
    expect(reduceWebuiShellSurface(surface, { type: "show-conversation" })).not.toBe(surface);
    const conversation = reduceWebuiShellSurface(surface, { type: "show-conversation" });
    // Re-running the mount-time effect and clicking the already-active 新建任务
    // row must not loop: the reducer hands back the same object.
    expect(reduceWebuiShellSurface(conversation, { type: "show-conversation" })).toBe(conversation);
    expect(reduceWebuiShellSurface(conversation, { type: "close-plugin-management" })).toBe(conversation);
  });
});

describe("shell surface wiring", () => {
  const shell = readFileSync(
    new URL("../../src/client/shell/WebuiClientFoundationApp.tsx", import.meta.url),
    "utf8",
  );
  // The new-task workspace behaviour moved out of the frame; the probe
  // below follows the responsibility, not the file it used to sit in.
  const newTaskWorkspace = readFileSync(
    new URL("../../src/client/shell/use-new-task-workspace.ts", import.meta.url),
    "utf8",
  );

  it("returns to the conversation when the selected session changes", () => {
    // Rail session rows are `#session=<id>` anchors: the click resolves through
    // the hashchange subscription inside `useSelectedSessionId`, not through the
    // setter the shell holds. Watching the resolved id is what covers both.
    expect(shell).toMatch(
      /useEffect\(\(\) => \{\s*dispatchShellSurface\(\{ type: "show-conversation" \}\);\s*\}, \[dispatchShellSurface, selectedSessionId\]\);/,
    );
  });

  it("returns to the conversation from 新建任务, which may not change the session", () => {
    const startNewTask = newTaskWorkspace.slice(newTaskWorkspace.indexOf("const startNewTask ="));
    expect(startNewTask).toContain('dispatchShellSurface({ type: "show-conversation" })');
  });

  it("gives each business zone its own recovery boundary", () => {
    // One root boundary meant a throw in the workspace panel unmounted the
    // composer, the transcript and the rail — losing an unsent draft because a
    // file tree failed to render. Each zone holds its own throw now.
    for (const zone of ["composer", "transcript", "workspace", "plugins", "scheduling"]) {
      expect(shell).toMatch(new RegExp(`<WebuiZoneBoundary\\s+zone="${zone}"`));
    }
  });

  it("opens the scheduled-task panel as a surface of its own, and keeps it idempotent", () => {
    // ADR 0027: scheduled tasks are not session-scoped, so this is a surface rather than a tab of
    // the workspace panel or a section of the settings modal — and the rail is the only way back.
    const scheduling = reduceWebuiShellSurface(initialWebuiShellSurface, { type: "open-scheduling" });
    expect(scheduling).toEqual({ kind: "scheduling" });
    expect(isSchedulingSurface(scheduling)).toBe(true);
    expect(isPluginManagementSurface(scheduling)).toBe(false);
    // Re-opening keeps the state object, so React bails out of the re-render.
    expect(reduceWebuiShellSurface(scheduling, { type: "open-scheduling" })).toBe(scheduling);
    // Closing, and any conversation navigation, collapse to the conversation.
    expect(reduceWebuiShellSurface(scheduling, { type: "show-conversation" })).toEqual({
      kind: "conversation",
    });
    expect(isSchedulingSurface(initialWebuiShellSurface)).toBe(false);
  });

  it("gates the marketplace on the surface rather than a separate boolean", () => {
    // A second flag is how the two got out of step: the gate read `open`, the
    // area came from elsewhere, and nothing tied either to navigation.
    expect(shell).toContain('from "../features/shell/projection/shell-surface.js"');
    // The plugin management area renders inside its own recovery zone, so a
    // throw in the marketplace does not take the rail and the composer with it.
    expect(shell).toContain('pluginManagementArea ? <WebuiZoneBoundary zone="plugins"><PluginCatalogue');
    expect(shell).not.toContain("setPluginManagementOpen");
    expect(shell).not.toContain("setPluginManagementArea");
  });
});
