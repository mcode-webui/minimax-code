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
} from "../../src/client/features/models/projection/token-plan-model.public.js";
import {
  readContextUsageFromPage,
  readContextWindowUsage,
} from "../../src/client/features/composer/contracts/context-usage.js";

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
const indicatorPath = path.resolve(
  here,
  "../../src/client/features/composer/ui/ContextUsageIndicator.tsx",
);
const composerPath = path.resolve(here, "../../src/client/features/composer/ui/WebuiComposer.tsx");
/** The shared skeleton, which opens the panel and owns its dismissal. */
const dropdownPath = path.resolve(here, "../../src/client/ui/Dropdown.tsx");
const dropdown = readFileSync(dropdownPath, "utf8");

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

describe("context window usage — the numbers, whichever way they are spelled", () => {
  it("reads the protocol's snake_case pair", () => {
    expect(
      readContextWindowUsage({ total_tokens: 120, context_window: 2000 }),
    ).toEqual({ used: 120, limit: 2000 });
  });

  it("reads the stored camelCase pair", () => {
    // This is the shape a PERSISTED session message's usage actually has, and
    // reading only the snake_case pair is what left the composer's readout
    // blank for every session the user opened.
    expect(
      readContextWindowUsage({ totalTokens: 120, contextWindow: 2000 }),
    ).toEqual({ used: 120, limit: 2000 });
  });

  it("reads the live snapshot's pair", () => {
    expect(
      readContextWindowUsage({ usedTokens: 120, contextWindowTokens: 2000 }),
    ).toEqual({ used: 120, limit: 2000 });
  });

  it("reads a zero as a zero, not as no data", () => {
    // A session that has produced context and spent none of it yet still has
    // a window to report on, and a zero is a reading.
    expect(
      readContextWindowUsage({ total_tokens: 0, context_window: 2000 }),
    ).toEqual({ used: 0, limit: 2000 });
  });

  it("reports an unknown window as unknown, and keeps the spent amount", () => {
    // A model whose window the runtime does not know still has a spent
    // window, and the readout can carry that fact.
    expect(readContextWindowUsage({ totalTokens: 120 })).toEqual({
      used: 120,
      limit: undefined,
    });
  });

  it("reports no data for a record with no numbers in it", () => {
    expect(readContextWindowUsage(undefined)).toEqual({ used: undefined, limit: undefined });
    expect(readContextWindowUsage({ components: [] })).toEqual({ used: undefined, limit: undefined });
  });
});

describe("context window usage — read from the page that owns it", () => {
  it("prefers the page's context snapshot", () => {
    // The server's snapshot names the window the runtime billed against, and
    // it is the richer half of the page.
    expect(
      readContextUsageFromPage({
        contextSnapshot: { status: "live", usage: { total_tokens: 120, context_window: 2000 } },
        messages: [],
      }),
    ).toEqual({ total_tokens: 120, context_window: 2000 });
  });

  it("falls back to the newest message that reported usage", () => {
    // A page without a snapshot still carries the reading on its messages.
    expect(
      readContextUsageFromPage({
        messages: [
          { msgId: "m1", role: "assistant", usage: { totalTokens: 10, contextWindow: 2000 } },
          { msgId: "m2", role: "assistant", usage: { totalTokens: 120, contextWindow: 2000 } },
        ],
      }),
    ).toEqual({ totalTokens: 120, contextWindow: 2000 });
  });

  it("reports nothing for a page that carries no reading at all", () => {
    expect(readContextUsageFromPage(undefined)).toBeUndefined();
    expect(readContextUsageFromPage({ messages: [] })).toBeUndefined();
  });
});

describe("context panel — what the plan section is bound to", () => {
  const indicatorSource = readFileSync(indicatorPath, "utf8");

  it("gates the plan meters on the SELECTED model, not on being signed in", () => {
    // `signedIn` alone is what printed Zhipu's context usage under a MiniMax
    // plan heading. Both halves are required, and the model half is the new one.
    const indicator = indicatorSource.slice(
      indicatorSource.indexOf("function ContextUsageIndicator"),
    );
    expect(indicator).toContain("isTokenPlanModel(planModel)");
    expect(indicator).not.toContain("usageQuota?.signedIn ? usageQuota : undefined");
  });

  it("is handed the selected model rather than any model", () => {
    // The whole list would make the gate depend on which model happens to be in
    // the catalogue rather than which one is in front of the user. The call site
    // belongs to the composer, so this read is the composer's.
    expect(readFileSync(composerPath, "utf8")).toContain("planModel={selectedModel}");
  });
});

describe("context panel — hover names it, click opens it", () => {
  const indicatorSource = readFileSync(indicatorPath, "utf8");
  const indicator = indicatorSource.slice(indicatorSource.indexOf("function ContextUsageIndicator"));

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
    // The ring is the trigger, and the shared skeleton owns the toggle: its
    // trigger's click opens a closed dropdown and closes an open one. The
    // indicator's own job is to say what opening means — the panel opens
    // folded, every time.
    expect(indicator).toContain("<WebuiDropdown");
    expect(indicator).toContain("onOpen={() => {");
    expect(indicator).toContain("onClose={() => setOpen(false)}");
    expect(dropdown).toContain("if (open) onClose();");
    expect(dropdown).toContain("else onOpen();");
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
    // The dismissal belongs to the shared skeleton: it reads the press before
    // the click reaches whatever was underneath, and Escape closes the panel
    // and returns the focus to the ring that opened it. The indicator keeps no
    // listener of its own, because a second one would close the panel twice.
    expect(indicator).not.toContain("listenForPointerDown");
    expect(indicator).not.toContain("onKeyDown");
    // The shared dropdown owns the dismissal: it reads the press before the
    // click reaches whatever was underneath, and Escape closes the panel and
    // returns the focus to the ring that opened it.
    expect(dropdown).toContain("useOverlayLayer({");
    expect(dropdown).toContain("triggerRef.current?.focus?.();");
  });
});

describe("context panel — the six-category split is folded until asked for", () => {
  const indicatorSource = readFileSync(indicatorPath, "utf8");
  const indicator = indicatorSource.slice(indicatorSource.indexOf("function ContextUsageIndicator"));

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
      /onOpen=\{\(\) => \{\s*setOpen\(true\);\s*setBreakdownOpen\(false\);/u,
    );
  });
  it("puts the disclosure on the heading row, with a chevron that states it", () => {
    // A caret beside the number is the "there is more under
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
      path.resolve(here, "../../src/client/features/transcript/ui/transcript.css"),
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
