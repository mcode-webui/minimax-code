// The account menu's shell and its two panels.
//
// The three conditions all constrain where state lives, and none of them is visible from the rendered
// markup alone, which is why this file reads the three modules. The card and the popover need a DOM to
// exercise, so the interactions are asserted as named expressions instead: moving a flag into a panel,
// loading a panel on mount, or letting a panel dismiss itself turns a case red.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const DIR = new URL("../../src/client/features/account/ui/", import.meta.url);
const read = (name: string): string => readFileSync(fileURLToPath(new URL(name, DIR)), "utf8");

const shell = read("UserMenu.tsx");
const signin = read("UserMenuSignin.tsx");
const usage = read("UserMenuUsage.tsx");

describe("the menu keeps the two open flags and the mutual exclusion (LC-7)", () => {
  it("declares both flags itself", () => {
    for (const flag of ["const [usageOpen, setUsageOpen] = useState(false);", "const [signinOpen, setSigninOpen] = useState(false);"]) {
      expect(shell).toContain(flag);
    }
  });

  it("opens one panel only by closing the other", () => {
    expect(shell).toContain("const loadUsage = (forceRefresh = false) => {\n    setUsageOpen(true);\n    setSigninOpen(false);");
    expect(shell).toContain("const loadSignin = () => {\n    setSigninOpen(true);\n    setUsageOpen(false);");
  });

  it("keeps both flags out of the panels", () => {
    for (const source of [signin, usage]) {
      expect(source).not.toContain("setUsageOpen");
      expect(source).not.toContain("setSigninOpen");
      expect(source).not.toContain("closePanels");
    }
  });
});

describe("dismissal stays with the menu (LC-8)", () => {
  it("closes both panels from the one dismissal helper", () => {
    expect(shell).toContain("const closePanels = () => {\n    if (panelCloseTimer.current !== undefined) {\n      clearTimeout(panelCloseTimer.current);");
    expect(shell).toContain("    setUsageOpen(false);\n    setSigninOpen(false);\n  };");
    // The rail's own trigger closes them too, and the two cross-panel jumps do: check-in -> usage is
    // the one that used to be easy to lose, since it starts inside the panel that is going away.
    expect(shell).toContain("setSigninOpen(false);\n                    loadUsage();");
  });

  it("routes the outside pointer and Escape through the shared rule", () => {
    // The menu is a `WebuiDropdown` now: the shared skeleton owns the outside
    // press and the Escape, so the menu itself no longer attaches a listener
    // or asks the policy table. The rule it used to follow is the one the
    // skeleton implements — a press outside closes, Escape closes.
    expect(shell).toContain("WebuiDropdown");
    expect(shell).not.toMatch(/evaluateOutsideClose\(\{/u);
    expect(shell).not.toMatch(/listenForPointerDown|listenForKeyDown/u);
    expect(shell).not.toContain('surface: "userMenuSignin"');
  });
});

describe("the panels load on demand, never on mount (LC-9)", () => {
  it("opens each panel from a hover, focus or click on the menu", () => {
    expect(shell).toContain("onMouseEnter={() => { cancelPanelClose(); loadSignin(); }} onMouseLeave={schedulePanelClose} onFocus={() => { cancelPanelClose(); loadSignin(); }}");
    expect(shell).toContain("onMouseEnter={() => { cancelPanelClose(); loadUsage(); }} onMouseLeave={schedulePanelClose} onFocus={() => { cancelPanelClose(); loadUsage(); }}");
  });

  it("gives neither panel a mount-time load", () => {
    // The panels hold no effect and no hooks beyond local presentation state: the menu's handlers are
    // the only thing that asks the owner for an answer.
    for (const source of [signin, usage]) {
      expect(source).not.toContain("useEffect(");
      expect(source).not.toContain("loadUsage(");
      expect(source).not.toContain("loadSigninPanel(");
      expect(source).not.toContain("useWebuiAccountWorkflows");
    }
  });
});

describe("the account answers come from the one owner", () => {
  it("has the menu read the snapshot and call published commands, and hold no transport", () => {
    expect(shell).toContain("useWebuiAccountWorkflowsState()");
    for (const source of [shell, signin, usage]) {
      // No member is read off a composed transport — the word appears in the shell's own comment
      // explaining that, which is why the assertion is about the read and not the token.
      // `webui-shell-seam.test.ts` holds the whole shell to that, comment lines included.
      expect(source).not.toMatch(/transport\./u);
      expect(source).not.toContain("invoke(");
    }
  });
});

describe("the two cross-surface jumps stay in the menu", () => {
  it("sends the check-in panel's 查看用量 on to the quota popover", () => {
    // The one that starts inside the panel that is going away, so it has to close check-in first.
    expect(shell).toContain("setSigninOpen(false);\n                    loadUsage();");
  });

  it("sends the quota popover's login action on to the login dialog", () => {
    expect(shell).toContain("onLogin={() => { setOpen(false); setLoginOpen(true); }}");
  });
});

describe("a quota failure is an error with a retry, not an empty panel", () => {
  it("renders the error state with a retry control wired to the loader", () => {
    expect(usage).toContain('state.status === "error" ? (');
    expect(usage).toContain('data-testid="usage-popover-error"');
    expect(usage).toContain("onClick={onRetry}");
    expect(usage).toContain("重试");
  });
});
