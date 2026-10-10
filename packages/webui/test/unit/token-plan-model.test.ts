/**
 * `isTokenPlanModel` — whose bill the context panel's plan meters describe.
 *
 * The bug this exists for: the panel printed 套餐用量, the account's five-hour
 * and weekly limits, for ANY signed-in account, including next to a model from a
 * completely different vendor's coding plan. The numbers were real and the
 * heading was true; the pairing was the lie.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  CUSTOM_PROVIDER_ID_PREFIX,
  MANAGED_MINIMAX_PROVIDER_ID,
  MINIMAX_API_PROVIDER_ID,
  isTokenPlanModel,
} from "../../src/client/projection/token-plan-model.js";

// The client imports no `@mavis/*` module and the package boundary check keeps
// it that way, so these three are mirrored rather than imported. A mirror with
// no tripwire is a copy that rots silently, so it is compared against the real
// exports here — a node-side test may import the package freely.
import {
  CUSTOM_PROVIDER_ID_PREFIX as CONFIGURED_CUSTOM_PREFIX,
  MANAGED_MINIMAX_PROVIDER_ID as CONFIGURED_MANAGED_ID,
  MINIMAX_API_PROVIDER_ID as CONFIGURED_API_KEY_ID,
} from "@mavis/config";

const here = path.dirname(fileURLToPath(import.meta.url));
const composerPath = path.resolve(
  here,
  "../../src/client/components/SessionComposer.tsx",
);

describe("token plan model — the mirrored provider ids", () => {
  it("still equals the ones @mavis/config exports", () => {
    // If the runtime renames a reserved provider id, this goes red instead of
    // the panel quietly deciding that no model is ever plan-metered.
    expect(MANAGED_MINIMAX_PROVIDER_ID).toBe(CONFIGURED_MANAGED_ID);
    expect(MINIMAX_API_PROVIDER_ID).toBe(CONFIGURED_API_KEY_ID);
    expect(CUSTOM_PROVIDER_ID_PREFIX).toBe(CONFIGURED_CUSTOM_PREFIX);
  });
});

describe("token plan model — whose usage the plan pays for", () => {
  it("claims a first-party MiniMax model", () => {
    expect(isTokenPlanModel({ providerId: "minimax", providerSource: "provider" })).toBe(true);
  });

  it("rejects another vendor's coding plan", () => {
    // The reported case: glm-5.3 from a Zhipu coding plan, with MiniMax's
    // five-hour and weekly meters printed under it.
    expect(
      isTokenPlanModel({
        providerId: "custom_provider:zhipu-ai-coding-plan",
        providerSource: "custom_provider",
      }),
    ).toBe(false);
    expect(
      isTokenPlanModel({
        providerId: "custom_provider:openai-codex",
        providerSource: "custom_provider",
      }),
    ).toBe(false);
  });

  it("rejects MiniMax reached through the user's OWN api key", () => {
    // Same vendor, same model names, different bill. A test on the provider's
    // NAME would call this one true and print a plan the key is not spending.
    expect(isTokenPlanModel({ providerId: "minimax_api", providerSource: "minimax_api" })).toBe(
      false,
    );
  });

  it("rejects a custom provider that understates its own source", () => {
    // The id prefix is the authority here, not the declared enum: a custom
    // provider is another vendor's plan whatever it says it is.
    expect(
      isTokenPlanModel({ providerId: "custom_provider:acme", providerSource: "provider" }),
    ).toBe(false);
  });

  it("has no opinion about no model at all", () => {
    // The caller is deciding whether to SHOW a section.
    expect(isTokenPlanModel(undefined)).toBe(false);
  });

  it("falls back to the managed id when the source did not arrive", () => {
    // A missing enum is not evidence of another provider, and the managed id is
    // the only first-party provider this product ships.
    expect(isTokenPlanModel({ providerId: "minimax" })).toBe(true);
    expect(isTokenPlanModel({ providerId: "custom_provider:zhipu-ai-coding-plan" })).toBe(false);
  });
});

describe("context panel — what the plan section is bound to", () => {
  const composer = readFileSync(composerPath, "utf8");

  it("gates the plan meters on the SELECTED model, not on being signed in", () => {
    // `signedIn` alone is what printed Zhipu's context usage under a MiniMax
    // plan heading. Both halves are required, and the model half is the new one.
    const indicator = composer.slice(
      composer.indexOf("function ContextUsageIndicator"),
    );
    expect(indicator).toContain("isTokenPlanModel(planModel)");
    expect(indicator).not.toContain("usageQuota?.signedIn ? usageQuota : undefined");
  });

  it("is handed the selected model rather than any model", () => {
    // The whole list would make the gate depend on which model happens to be in
    // the catalogue rather than which one is in front of the user.
    expect(composer).toContain("planModel={selectedModel}");
  });
});

describe("context panel — hover names it, click opens it", () => {
  const composer = readFileSync(composerPath, "utf8");
  const indicator = composer.slice(composer.indexOf("function ContextUsageIndicator"));

  it("does not open the panel on hover", () => {
    // The panel is six breakdown rows plus a set of plan meters. Opening that
    // under a pointer threw it over the transcript on every pass towards the
    // send button, and took it away again on the way out.
    const code = indicator
      .split("\n")
      .filter((line) => !line.trimStart().startsWith("//"))
      .join("\n");
    expect(code).not.toMatch(/onMouseEnter=\{\(\) => setOpen\(true\)\}/u);
    expect(code).not.toMatch(/onMouseLeave=\{\(\) => setOpen\(false\)\}/u);
    // Hover still tracks, for the label.
    expect(code).toContain("onMouseEnter={() => setHovered(true)}");
  });

  it("opens on the click and toggles on a second one", () => {
    expect(indicator).toMatch(/onClick=\{\(\) => \{\s*setOpen\(\(value\) => !value\);/u);
  });

  it("carries a hover label naming the ring, hidden from assistive tech", () => {
    // `aria-hidden` because the button's own aria-label already announces the
    // same words; a bubble repeating them is read twice.
    expect(indicator).toContain("上下文窗口");
    expect(indicator).toContain("webui-context-usage-label");
    expect(indicator).toMatch(/className="webui-context-usage-label"\s+aria-hidden="true"/u);
  });

  it("hides the label while the panel is open", () => {
    // Otherwise hovering the ring that owns an open panel stacks a bubble on
    // top of the panel's own heading, saying the same word twice.
    expect(indicator).toContain('hovered && !open ? "true" : "false"');
  });

  it("dismisses on Escape and on a press outside", () => {
    expect(indicator).toContain('if (event.key === "Escape") setOpen(false)');
    // `pointerdown` in the CAPTURE phase: the press that lands outside has to
    // dismiss the panel rather than being handed to whatever is underneath.
    expect(indicator).toContain("dom.listenForPointerDown(onPointerDown, true)");
  });
});

describe("context panel — the six-category split is folded until asked for", () => {
  const composer = readFileSync(composerPath, "utf8");
  const indicator = composer.slice(composer.indexOf("function ContextUsageIndicator"));

  it("starts folded, not expanded", () => {
    // Six rows of percentages is a reading task. The panel opens on the two
    // things a glance is for — how full the window is, how much plan is left —
    // and the split waits for the user who came to read it.
    expect(indicator).toContain("const [breakdownOpen, setBreakdownOpen] = useState(false)");
  });

  it("folds again on every open, rather than remembering the last visit", () => {
    // Otherwise a glance at the panel lands on six rows because of something
    // the user did a minute ago and has since stopped caring about.
    expect(indicator).toMatch(
      /setOpen\(\(value\) => !value\);\s*setBreakdownOpen\(false\);/u,
    );
  });
  it("puts the disclosure on the heading row, with a chevron that states it", () => {
    // A caret beside the number is the desktop's own "there is more under
    // this" convention, and a separate 详情 button next to it would be two
    // controls for one section.
    expect(indicator).toContain("webui-context-usage-disclosure");
    expect(indicator).toContain("aria-expanded={breakdownOpen}");
    expect(indicator).toContain("aria-controls=\"webui-context-usage-breakdown\"");
    expect(indicator).toContain("webui-context-usage-chevron");
  });

  it("hides the rows rather than unmounting them", () => {
    // `hidden` keeps the six rows out of the tab order and out of the
    // accessibility tree while folded, and keeps the bar's segment widths from
    // being recomputed on the first open.
    expect(indicator).toContain("hidden={!breakdownOpen}");
  });

  it("tells the cascade about the folded state, because `hidden` alone does not", () => {
    // The failure this catches was invisible in the markup and obvious on
    // screen: the element carried `hidden=""`, and the rows rendered anyway.
    // `[hidden] { display: none }` lives in the UA stylesheet, so the
    // `display: flex` on the same class outranks it and the rows stayed both
    // visible and in the accessibility tree. A DOM assertion passes on this;
    // only the stylesheet says otherwise.
    const css = readFileSync(
      path.resolve(here, "../../src/client/styles/shell.css"),
      "utf8",
    );
    expect(css).toContain(".webui-context-usage-components[hidden] { display: none; }");
  });

  it("keeps the bar's segments outside the disclosure", () => {
    // The bar is the glance. Folding it away with the rows would leave a
    // heading, a chevron and a plan section, with nothing between them saying
    // how full the window is.
    const bar = indicator.indexOf("webui-context-usage-bar");
    const rows = indicator.indexOf("webui-context-usage-components");
    expect(bar).toBeGreaterThan(-1);
    expect(rows).toBeGreaterThan(bar);
    expect(indicator.slice(bar, rows)).not.toContain("hidden={!breakdownOpen}");
  });
});
