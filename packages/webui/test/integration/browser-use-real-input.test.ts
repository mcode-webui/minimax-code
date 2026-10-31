// The browser input path, against a real browser and a real page.
//
// The unit suite proves the *decisions*: that a malformed command is refused,
// that a stale generation is refused, that a disabled surface is refused. It
// uses a fake provider, so it cannot prove that the decision reaches the page.
//
// This suite closes that gap. It launches the real isolated Chromium, drives a
// real page, and checks what the page actually received:
//
//   * text input reaches the page the provider is showing;
//   * after a navigation replaces the page, an input recorded against the
//     previous page is refused and the new page does not receive it.
//
// The browser is optional: a machine without Chrome skips the suite rather
// than failing it, because "the browser is missing" is not a defect in the
// input path. The repository's `test:webui-browser` gate is the one that
// requires a browser.

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { WebuiIsolatedChromiumProvider } from "../../src/runtime/browser/isolated-chromium/provider.js";
import type { WebuiBrowserTargetId } from "../../src/shared/contracts/browser.js";
import { beginAcceptanceSuite, observeAcceptance, restoreAcceptanceRecords } from "../browser/acceptance-record.js";

/** The record file this suite writes. */
const SUITE = "isolated-chromium";

/**
 * A page that records what it received.
 *
 * The value is written into the title, so the provider's own target listing
 * can observe it: the test reads the page's state through the same public
 * surface the panel uses, rather than through a private back channel.
 */
const PAGE_HTML = [
  "<!doctype html><title>idle</title>",
  "<input id='field' type='text'>",
  "<button id='go' onclick=\"document.title = 'clicked'\">go</button>",
  "<script>",
  "document.getElementById('field').addEventListener('input', (event) => {",
  "  document.title = 'text:' + event.target.value;",
  "});",
  "</script>",
].join("\n");

async function chromeIsAvailable(): Promise<boolean> {
  return (await resolveChromePath()) !== undefined;
}

/** The Chrome the isolated provider drives, and its own version. */
async function resolveChromePath(): Promise<string | undefined> {
  const { access } = await import("node:fs/promises");
  for (const candidate of [
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
  ]) {
    try {
      await access(candidate);
      return candidate;
    } catch {
      // Keep looking.
    }
  }
  return undefined;
}

/**
 * The browser's own version.
 *
 * Read from the binary rather than assumed: an acceptance record that says
 * "Chrome" without saying which Chrome is not a record.
 */
async function chromeVersion(path: string): Promise<string> {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const run = promisify(execFile);
  try {
    const { stdout } = await run(path, ["--version"], { timeout: 20_000 });
    return stdout.trim();
  } catch {
    return "unknown";
  }
}

const available = await chromeIsAvailable();

describe.skipIf(!available)("the browser input path, against a real page", () => {
  let dataDir: string;
  let provider: WebuiIsolatedChromiumProvider;
  let browserVersion = "unknown";

  beforeAll(async () => {
    // The record is emptied here, at the start of the run: a run that failed
    // during setup would otherwise leave the previous run's cases in place.
    beginAcceptanceSuite(SUITE);
    dataDir = await mkdtemp(join(tmpdir(), "webui-browser-use-e2e-"));
    provider = await WebuiIsolatedChromiumProvider.launch({ dataDir });
    const path = await resolveChromePath();
    if (path) browserVersion = await chromeVersion(path);
  }, 60_000);

  afterAll(async () => {
    // This suite rewrites the record file, and the file is tracked, so on CI
    // the run puts it back the way the checkout had it.
    restoreAcceptanceRecords();
    await provider?.close();
    if (dataDir) await rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  /** The field's centre, in page coordinates. */
  async function fieldCentre(): Promise<{ x: number; y: number }> {
    const result = (await provider.sendCommand(await pageTarget(), "Runtime.evaluate", {
      expression:
        "(() => { const r = document.getElementById('field').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()",
      returnByValue: true,
    })) as { result?: { value?: unknown } } | undefined;
    const value = result?.result?.value as { x?: number; y?: number } | undefined;
    return { x: value?.x ?? 0, y: value?.y ?? 0 };
  }

  /**
   * The identity of the page the provider is driving.
   *
   * It is the provider's own selected target, read back from the provider, so
   * the command is aimed at the page the test is actually looking at.
   */
  async function pageTarget(): Promise<WebuiBrowserTargetId> {
    const selected = (await provider.listTargets()).find((entry) => entry.selected);
    if (!selected) throw new Error("the provider reported no selected target");
    return selected.id;
  }

  async function readFieldValue(): Promise<string> {
    const result = (await provider.sendCommand(await pageTarget(), "Runtime.evaluate", {
      expression: "document.getElementById('field').value",
      returnByValue: true,
    })) as { result?: { value?: unknown } } | undefined;
    return typeof result?.result?.value === "string" ? result.result.value : "";
  }

  async function navigate(url: string): Promise<void> {
    await provider.sendCommand(await pageTarget(), "Page.navigate", { url });
    // The renderer is swapped during a navigation; a command issued into that
    // window fails with "Not attached to an active page", so the test waits
    // for the page to settle before it asserts anything about it.
    await new Promise((resolve) => setTimeout(resolve, 750));
  }

  it("delivers text input to the page the provider is showing", async () => {
    await observeAcceptance(
      SUITE,
      {
        surface: "isolated-chromium",
        browser: "chrome",
        browserVersion,
        entry: "development",
        case: "the isolated Chromium delivers text input to the page it is showing",
        settings: {
          // The isolated surface is driven directly by the provider, so there
          // is no allowlist and no extension: the runtime's own switch is the
          // only authorization, and it is on for this case.
          surface: "isolated-chromium",
          isolatedChromium: true,
          edge: "not carried by the isolated surface",
          chrome: "not carried by the isolated surface",
          fullCdp: "not exercised by this case",
          allowlist: "not applicable",
          build: "not applicable",
        },
        observed: "a pointer click and a text input both arrived in the page the provider was driving",
      },
      async () => {
        await navigate(`data:text/html,${encodeURIComponent(PAGE_HTML)}`);
        // The provider marks the page it drives as the selected one. Picking
        // "the first page" would pick a different tab when the browser has more
        // than one, and the input would then be addressed to a page the provider
        // is not driving.
        const targets = await provider.listTargets();
        const target = targets.find((entry) => entry.selected);
        expect(target).toBeDefined();
        expect(await readFieldValue()).toBe("");

        const identity = {
          surface: "isolated-chromium" as const,
          browserId: provider.browserId,
          targetId: target!.id.targetId,
          generation: target!.id.generation,
        };

        // A real pointer click first: text input goes to whatever holds the
        // focus, so the panel's user has to be able to aim at the field before
        // typing into it. This is the same path the panel uses.
        const centre = await fieldCentre();
        await provider.sendInput({
          kind: "pointer",
          target: identity,
          x: centre.x,
          y: centre.y,
          button: "left",
          clickCount: 1,
        });

        await provider.sendInput({ kind: "text", target: identity, text: "hello" });

        expect(await readFieldValue()).toBe("hello");
      },
    );
  });

  it("refuses an input recorded against the page a navigation replaced", async () => {
    await observeAcceptance(
      SUITE,
      {
        surface: "isolated-chromium",
        browser: "chrome",
        browserVersion,
        entry: "development",
        case: "the isolated Chromium refuses an input recorded against the page a navigation replaced",
        settings: {
          // The isolated surface is driven directly by the provider, so there
          // is no allowlist and no extension: the runtime's own switch is the
          // only authorization, and it is on for this case.
          surface: "isolated-chromium",
          isolatedChromium: true,
          edge: "not carried by the isolated surface",
          chrome: "not carried by the isolated surface",
          fullCdp: "not exercised by this case",
          allowlist: "not applicable",
          build: "not applicable",
        },
        observed:
          "the stale identity was refused with browser_target_stale and the page that replaced it received nothing",
      },
      async () => {
        await navigate(`data:text/html,${encodeURIComponent(PAGE_HTML)}`);
        const before = (await provider.listTargets()).find((entry) => entry.selected);
        expect(before).toBeDefined();

        // The navigation replaces the page behind the tab.
        await navigate(`data:text/html,${encodeURIComponent(PAGE_HTML)}`);
        const after = (await provider.listTargets()).find((entry) => entry.selected);
        expect(after).toBeDefined();

        // The provider raised its generation, so the identity recorded before the
        // navigation is stale.
        const stale = {
          surface: "isolated-chromium" as const,
          browserId: provider.browserId,
          targetId: before!.id.targetId,
          generation: before!.id.generation,
        };
        await expect(
          provider.sendInput({ kind: "text", target: stale, text: "must not arrive" }),
        ).rejects.toMatchObject({ code: "browser_target_stale" });

        // The page that replaced it received nothing.
        expect(await readFieldValue()).toBe("");
      },
    );
  });
});
