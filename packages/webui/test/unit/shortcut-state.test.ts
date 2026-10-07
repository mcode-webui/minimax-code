/* Roadmap P 区「快捷键管理」.
 *
 * The gap in the ledger reads "快捷键管理（可视化改键）: tab 禁用". That
 * undersells it. There is no shortcut system at all: the UserMenu labels the
 * settings row `Ctrl+,`, and no keydown listener anywhere in the client ever
 * honours that combination — the three document-level listeners that exist
 * belong to the context menu, the goal banner and the user-menu popover, and
 * each of them only handles Escape while its own popover is open. So the first
 * thing this registry has to survive is being the thing the label already
 * promised.
 *
 * Everything here is a pure function over a command list and a set of
 * overrides. The webui suite has no jsdom, so the module has to stay free of
 * DOM access and the presentational half lives in `SettingsModal.tsx` as an
 * exported component, exactly like `WebuiReviewPanel` from the E-area work.
 */

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { WebuiShortcutSettings } from "../../src/client/components/SettingsModal.js";
import {
  WEBUI_SHORTCUT_COMMANDS,
  parseWebuiShortcut,
  formatWebuiShortcut,
  resolveWebuiShortcutBindings,
  findWebuiShortcutConflict,
  matchesWebuiShortcut,
  webuiShortcutFromEvent,
  resetWebuiShortcutOverrides,
  parseWebuiShortcutOverrides,
  type WebuiShortcutBinding,
  type WebuiShortcutKeyEvent,
  type WebuiShortcutOverride,
} from "../../src/client/projection/shortcut-state.js";

describe("parsing a binding", () => {
  it("reads a modifier combination and a key", () => {
    expect(parseWebuiShortcut("Ctrl+,")).toEqual({ ctrl: true, meta: false, alt: false, shift: false, key: "," });
  });

  /* People type these in whatever order the muscle memory has. The stored
   * form has to canonicalise or a user who rewrites the same shortcut gets a
   * "different" one. */
  it("ignores the order the modifiers are written in", () => {
    expect(parseWebuiShortcut("Shift+Ctrl+P")).toEqual(parseWebuiShortcut("Ctrl+Shift+P"));
  });

  it("reads a lone key", () => {
    expect(parseWebuiShortcut("F2")).toEqual({ ctrl: false, meta: false, alt: false, shift: false, key: "F2" });
  });

  /* A modifier with no key is not a shortcut. Accepting it would store a
   * binding that fires on Ctrl+anywhere. */
  it("refuses a modifier with no key", () => {
    expect(parseWebuiShortcut("Ctrl")).toBeUndefined();
    expect(parseWebuiShortcut("Ctrl+Shift")).toBeUndefined();
  });

  it("refuses an empty or unknown token", () => {
    expect(parseWebuiShortcut("")).toBeUndefined();
    expect(parseWebuiShortcut("Ctrl+Hyper+K")).toBeUndefined();
  });
});

describe("formatting a binding for display", () => {
  it("round-trips through parse", () => {
    for (const command of WEBUI_SHORTCUT_COMMANDS) {
      expect(parseWebuiShortcut(formatWebuiShortcut(command.defaultBinding))).toEqual(
        parseWebuiShortcut(command.defaultBinding),
      );
    }
  });

  /* macOS users read ⌘, and every other platform reads Ctrl. Showing Ctrl+,
   * on a Mac describes a shortcut that does not exist there. */
  it("shows the primary modifier the platform actually uses", () => {
    const mac = formatWebuiShortcut("Ctrl+,", "darwin");
    expect(mac).toContain("⌘");
    expect(mac).not.toContain("Ctrl");

    const other = formatWebuiShortcut("Ctrl+,", "win32");
    expect(other).toContain("Ctrl");
    expect(other).not.toContain("⌘");
  });

  it("keeps a non-primary modifier visible on both platforms", () => {
    expect(formatWebuiShortcut("Ctrl+Shift+P", "darwin")).toContain("⇧");
  });
});

describe("matching a keyboard event", () => {
  const press = (binding: string, patch: Partial<WebuiShortcutKeyEvent> = {}) =>
    matchesWebuiShortcut(
      { ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, key: "?", ...patch },
      binding,
    );

  it("matches the combination it was bound to", () => {
    expect(press("Ctrl+,", { ctrlKey: true, key: "," })).toBe(true);
  });

  it("does not match the same key without its modifier", () => {
    expect(press("Ctrl+,", { key: "," })).toBe(false);
  });

  /* Holding an extra modifier makes it a different shortcut. Without this the
   * user could not press Ctrl+Shift+P for something else while Ctrl+, is
   * taken, and the dispatcher would fire on the longer press too. */
  it("does not match when an extra modifier is held", () => {
    expect(press("Ctrl+P", { ctrlKey: true, key: "p" })).toBe(true);
    expect(press("Ctrl+P", { ctrlKey: true, shiftKey: true, key: "p" })).toBe(false);
  });

  it("does not match a different key with the same modifier", () => {
    expect(press("Ctrl+,", { ctrlKey: true, key: "m" })).toBe(false);
  });

  /* Keyboard events report the physical key, so Shift+, arrives as "<". The
   * registry stores "Ctrl+Shift+," and it still has to fire. */
  it("matches a shifted punctuation key by its unshifted name", () => {
    expect(press("Ctrl+Shift+,", { ctrlKey: true, shiftKey: true, key: "<" })).toBe(true);
  });

  it("matches a letter regardless of case", () => {
    expect(press("Ctrl+Shift+P", { ctrlKey: true, shiftKey: true, key: "P" })).toBe(true);
    expect(press("Ctrl+Shift+P", { ctrlKey: true, shiftKey: true, key: "p" })).toBe(true);
  });

  it("never matches an unparseable binding", () => {
    expect(press("Ctrl+", { ctrlKey: true, key: "," })).toBe(false);
  });
});

describe("resolving the effective bindings", () => {
  it("falls back to every default when nothing is overridden", () => {
    const resolved = resolveWebuiShortcutBindings([]);
    expect(resolved.size).toBe(WEBUI_SHORTCUT_COMMANDS.length);
    for (const command of WEBUI_SHORTCUT_COMMANDS) {
      expect(resolved.get(command.id)).toBe(command.defaultBinding);
    }
  });

  it("lets an override win for its own command only", () => {
    const overrides: readonly WebuiShortcutOverride[] = [{ id: "openSettings", binding: "Ctrl+Shift+," }];
    const resolved = resolveWebuiShortcutBindings(overrides);
    expect(resolved.get("openSettings")).toBe("Ctrl+Shift+,");
    expect(resolved.get("toggleSidebar")).toBe(WEBUI_SHORTCUT_COMMANDS.find((c) => c.id === "toggleSidebar")?.defaultBinding);
  });

  /* A hand-edited localStorage entry, or one written by a build that knew
   * about a command this one does not. It must not take the registry down. */
  it("ignores an override that names no known command", () => {
    const resolved = resolveWebuiShortcutBindings([{ id: "doesNotExist", binding: "Ctrl+Alt+Q" }]);
    expect(resolved.size).toBe(WEBUI_SHORTCUT_COMMANDS.length);
  });

  it("ignores an override whose binding cannot be parsed", () => {
    const resolved = resolveWebuiShortcutBindings([{ id: "openSettings", binding: "Ctrl+" }]);
    expect(resolved.get("openSettings")).toBe(
      WEBUI_SHORTCUT_COMMANDS.find((c) => c.id === "openSettings")?.defaultBinding,
    );
  });
});

describe("refusing a binding that is already taken", () => {
  const overrides: readonly WebuiShortcutOverride[] = [{ id: "openSettings", binding: "Ctrl+Shift+P" }];

  it("names the command that already holds it", () => {
    const clash = findWebuiShortcutConflict("Ctrl+Shift+P", "toggleSidebar", resolveWebuiShortcutBindings(overrides));
    expect(clash).toBe("openSettings");
  });

  it("does not report a command as clashing with itself", () => {
    const bindings = resolveWebuiShortcutBindings(overrides);
    expect(findWebuiShortcutConflict("Ctrl+Shift+P", "openSettings", bindings)).toBeUndefined();
  });

  it("allows a free binding", () => {
    const bindings = resolveWebuiShortcutBindings(overrides);
    expect(findWebuiShortcutConflict("Ctrl+Alt+9", "toggleSidebar", bindings)).toBeUndefined();
  });
});

describe("resetting", () => {
  it("drops the override for one command and keeps the others", () => {
    const overrides: readonly WebuiShortcutOverride[] = [
      { id: "openSettings", binding: "Ctrl+Shift+P" },
      { id: "toggleSidebar", binding: "Ctrl+Alt+B" },
    ];
    const after = resetWebuiShortcutOverrides(overrides, "openSettings");
    expect(after.some((entry) => entry.id === "openSettings")).toBe(false);
    expect(after.some((entry) => entry.id === "toggleSidebar")).toBe(true);
  });
});

describe("the registry itself", () => {
  it("gives every command a label, a group and a parseable default", () => {
    for (const command of WEBUI_SHORTCUT_COMMANDS) {
      expect(command.label.trim().length).toBeGreaterThan(0);
      expect(command.group.trim().length).toBeGreaterThan(0);
      expect(parseWebuiShortcut(command.defaultBinding)).toBeDefined();
    }
  });

  /* Two defaults on the same combination means the dispatcher can only ever
   * run one of them, and the settings page would show the same key twice. */
  it("never ships two commands on one combination", () => {
    const seen = new Map<string, string>();
    for (const command of WEBUI_SHORTCUT_COMMANDS) {
      const canonical = formatWebuiShortcut(command.defaultBinding);
      const owner = seen.get(canonical);
      expect(owner, `${command.id} duplicates ${owner} on ${canonical}`).toBeUndefined();
      seen.set(canonical, command.id);
    }
  });

  it("uses distinct ids", () => {
    const ids = WEBUI_SHORTCUT_COMMANDS.map((command) => command.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  /* Escape and the arrows are how menus close and lists navigate. Letting a
   * user rebind them would break every popover in the app, so no command may
   * default to one. */
  it("never defaults to Escape or a bare arrow key", () => {
    for (const command of WEBUI_SHORTCUT_COMMANDS) {
      const binding = parseWebuiShortcut(command.defaultBinding);
      expect(["escape", "arrowup", "arrowdown", "arrowleft", "arrowright", "enter", " "]).not.toContain(binding?.key);
    }
  });
});

describe("capturing a key the user just pressed", () => {
  const press = (patch: Partial<WebuiShortcutKeyEvent> & { key: string }) =>
    webuiShortcutFromEvent({
      ctrlKey: false,
      metaKey: false,
      altKey: false,
      shiftKey: false,
      ...patch,
    });

  it("records the combination literally", () => {
    expect(press({ ctrlKey: true, key: "K" })).toBe("Ctrl+k");
    expect(press({ ctrlKey: true, shiftKey: true, key: "P" })).toBe("Ctrl+Shift+p");
    expect(press({ metaKey: true, key: "k" })).toBe("Meta+k");
  });

  /* A rebind the user cannot back out of is worse than no rebind at all. */
  it("refuses a lone modifier, which is a press in progress", () => {
    expect(press({ ctrlKey: true, key: "Control" })).toBeUndefined();
    expect(press({ ctrlKey: true, key: "Shift" })).toBeUndefined();
  });

  it("refuses Escape, which is the cancel gesture", () => {
    expect(press({ ctrlKey: true, key: "Escape" })).toBeUndefined();
  });

  it("refuses a bare letter, which is just typing", () => {
    expect(press({ key: "k" })).toBeUndefined();
  });

  it("accepts a function key without a modifier", () => {
    expect(press({ key: "F2" })).toBe("F2");
  });

  /* Round-tripping is what stops a captured binding from being dropped on the
   * next read and the user's choice silently reverting. */
  it("always produces something the registry can read back", () => {
    for (const patch of [
      { ctrlKey: true, key: "," },
      { ctrlKey: true, shiftKey: true, key: "," },
      { metaKey: true, altKey: true, key: "k" },
      { key: "F12" },
    ] as const) {
      const binding = press({ ...patch });
      expect(parseWebuiShortcut(binding ?? "")).toBeDefined();
    }
  });
});

/* The registry is pure and testable; the page that renders it is not reachable
 * from `renderToStaticMarkup` in any useful way, so it is asserted directly as
 * an exported component and the click handlers that matter are covered by the
 * wiring assertions below. */
describe("the shortcut settings page", () => {
  const render = (props: Record<string, unknown> = {}): string =>
    renderToStaticMarkup(
      createElement(WebuiShortcutSettings, { overrides: [], platform: "win32", ...props } as never),
    );

  it("renders a row for every registered command, with its default binding", () => {
    const markup = render();
    expect(markup).toContain('data-testid="settings-shortcut-page"');
    for (const command of WEBUI_SHORTCUT_COMMANDS) {
      expect(markup).toContain(`data-webui-shortcut-id="${command.id}"`);
      expect(markup).toContain(command.label);
    }
    expect(markup).toContain("Ctrl+,");
  });

  it("shows the effective binding, not the default, once one is overridden", () => {
    expect(render({ overrides: [{ id: "openSettings", binding: "Ctrl+Shift+," }] })).toContain("Ctrl+Shift+,");
  });

  /* Without this the user cannot tell a rebound key from the shipped one, and
   * "reset" would appear to do nothing. */
  it("marks a row that no longer uses its default", () => {
    expect(render({ overrides: [{ id: "openSettings", binding: "Ctrl+Shift+," }] })).toContain(
      'data-webui-shortcut-overridden="true"',
    );
  });

  it("offers a reset only for a row that was overridden", () => {
    const overridden = render({ overrides: [{ id: "openSettings", binding: "Ctrl+Shift+," }] });
    expect(overridden.match(/data-testid="shortcut-reset"/gu)?.length ?? 0).toBe(1);
    expect(render().match(/data-testid="shortcut-reset"/gu)?.length ?? 0).toBe(0);
  });

  it("puts the commands into their groups", () => {
    const markup = render();
    for (const group of new Set(WEBUI_SHORTCUT_COMMANDS.map((command) => command.group))) {
      expect(markup).toContain(`>${group}</`);
    }
  });

  /* The reason the page exists is that a key already in use must not silently
   * shadow the other command. */
  it("names the command a chosen key is already taken by", () => {
    const owner = WEBUI_SHORTCUT_COMMANDS.find((command) => command.id === "toggleSidebar");
    const markup = render({
      editing: "focusComposer",
      conflict: { commandId: "toggleSidebar", label: owner?.label ?? "" },
    });
    expect(markup).toContain('data-testid="shortcut-conflict"');
    expect(markup).toContain('role="alert"');
    expect(markup).toContain(owner?.label ?? "");
  });

  it("shows the capture prompt only for the row being edited", () => {
    expect(render({ editing: "focusComposer" })).toContain('data-testid="shortcut-capture"');
    expect(render()).not.toContain('data-testid="shortcut-capture"');
  });
});

describe("parsing stored overrides", () => {
  it("reads a well-formed list", () => {
    expect(parseWebuiShortcutOverrides('[{"id":"openSettings","binding":"Ctrl+Shift+,"}]')).toEqual([
      { id: "openSettings", binding: "Ctrl+Shift+," },
    ]);
  });

  /* This comes out of localStorage, which survives a downgrade of this build.
   * A malformed entry must not stop the settings page from opening. */
  it("survives a hand-edited or stale value", () => {
    expect(parseWebuiShortcutOverrides("{not json")).toEqual([]);
    expect(parseWebuiShortcutOverrides('{"id":"x"}')).toEqual([]);
    expect(parseWebuiShortcutOverrides('[{"id":"openSettings"}]')).toEqual([]);
    expect(parseWebuiShortcutOverrides(null)).toEqual([]);
  });
});

/* Rows render above. These close the two loops a render cannot reach: that the
 * page is reachable from the tab at all, and that a global handler exists —
 * without which every binding in the registry is decoration, which is the
 * defect this change exists to remove. */
describe("wiring", () => {
  const source = readFileSync(
    fileURLToPath(new URL("../../src/client/components/SettingsModal.tsx", import.meta.url)),
    "utf8",
  );
  const app = readFileSync(
    fileURLToPath(new URL("../../src/client/components/WebuiClientFoundationApp.tsx", import.meta.url)),
    "utf8",
  );

  it("routes the shortcuts tab to its own page", () => {
    expect(source).toContain('{active === "shortcuts" ? <SettingsShortcutsPage');
  });

  /* Without this, the routing above can coexist with the tab still falling
   * through to the empty pane, and both would render at once — which is what
   * negative injection found while the routing assertion was already present.
   */
  it("keeps the shortcuts tab out of the empty-pane fallback", () => {
    const guard = source.split("webui-settings-empty-panel")[0]?.split('{active === "worktree"')?.at(-1) ?? "";
    expect(guard).toContain('active !== "shortcuts"');
  });

  it("stops excluding the shortcuts tab from the settings list", () => {
    expect(source).not.toContain('key: "shortcuts", group: "preferences", label: "快捷键", icon: "shortcuts", disabled: true');
  });

  it("installs one document-level key handler in the shell", () => {
    expect(app).toContain('document.addEventListener("keydown"');
    expect(app).toContain("resolveWebuiShortcutBindings");
  });

  /* The registry resolving is worth nothing if the handler feeds it an empty
   * list: the page would show saved keys and the shell would keep firing the
   * defaults. This is the seam between the two halves of the feature. */
  it("feeds the handler the user's saved overrides", () => {
    expect(app).toContain("WEBUI_SHORTCUT_OVERRIDES_KEY");
    expect(app).toContain("parseWebuiShortcutOverrides(localStorage.getItem(WEBUI_SHORTCUT_OVERRIDES_KEY))");
  });

  /* Each registered id must have a branch behind it. A command in the registry
   * with no handler is exactly the "a row that says something and does
   * nothing" bug. */
  it("gives every registered command an action in the shell", () => {
    for (const command of WEBUI_SHORTCUT_COMMANDS) {
      expect(app, `no handler for ${command.id}`).toContain(`"${command.id}"`);
    }
  });
});
