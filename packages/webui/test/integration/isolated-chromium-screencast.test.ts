// The screencast keeps flowing.
//
// A screencast is a stream, not a series of screenshots: Chromium holds the
// next frame until the previous one is acknowledged, and the acknowledgement
// goes to the **page's** session. An ack that goes anywhere else leaves the
// page frozen on whatever it first drew — so the panel shows a page that never
// changes, and a click that lands in the browser is never seen again.
//
// This suite drives a page that changes by itself — a clock — and asks the
// provider for its frames. The frames have to keep coming.
//
// The browser is optional: a machine without Chrome skips the suite rather
// than failing it, because "the browser is missing" is not a defect in the
// provider. The repository's `test:webui-browser` gate is the one that
// requires a browser.

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { WebuiIsolatedChromiumProvider } from "../../src/runtime/browser/isolated-chromium/provider.js";
import { webuiBrowserPicturePoint } from "../../src/client/features/browser/application/browser-commands.js";
import type { WebuiBrowserImageFrame, WebuiBrowserTargetId } from "../../src/shared/contracts/browser.js";

/** How long the page is given to tick. */
const WATCH_MS = 3_000;

/** A page with a clock, so it changes by itself. */
function tickingPageUrl(): string {
  const html = [
    "<!doctype html><title>tick</title>",
    "<div id='clock' style='font:48px monospace'>--</div>",
    "<script>",
    "setInterval(() => { document.getElementById('clock').textContent = String(Date.now()); }, 100);",
    "</script>",
  ].join("\n");
  return `data:text/html,${encodeURIComponent(html)}`;
}

/** A page with a button that says whether it was clicked. */
function buttonPageUrl(): string {
  const html = [
    "<!doctype html><title>button</title>",
    "<button id='target' style='position:absolute;left:100px;top:80px;width:200px;height:60px'>click me</button>",
    "<div id='log'></div>",
    "<script>",
    "document.getElementById('target').addEventListener('click', () => {",
    "  document.getElementById('log').textContent = 'clicked';",
    "});",
    "</script>",
  ].join("\n");
  return `data:text/html,${encodeURIComponent(html)}`;
}

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

const available = (await resolveChromePath()) !== undefined;

describe.skipIf(!available)("the isolated Chromium's screencast", () => {
  let dataDir: string;
  let provider: WebuiIsolatedChromiumProvider;

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "webui-isolated-screencast-"));
    provider = await WebuiIsolatedChromiumProvider.launch({ dataDir });
  }, 60_000);

  afterAll(async () => {
    await provider?.close();
    if (dataDir) await rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  /**
   * The page the browser was launched with, pointed at the given url.
   *
   * The target is read again after the navigation: a page that navigates keeps
   * its id and gains a generation, and a command aimed at the previous
   * generation is refused — which is the point, but it means the caller has to
   * ask for the page that is there now.
   */
  async function launchTarget(url: string): Promise<{ readonly targetId: string; readonly id: WebuiBrowserTargetId }> {
    const selected = (await provider.listTargets()).find((entry) => entry.selected);
    if (!selected) throw new Error("the provider reported no selected target");
    await provider.sendCommand(selected.id, "Page.navigate", { url });
    await new Promise((resolve) => setTimeout(resolve, 500));
    const current = (await provider.listTargets()).find(
      (entry) => entry.id.targetId === selected.id.targetId,
    );
    if (!current) throw new Error("the navigated page is not in the target list");
    return { targetId: current.id.targetId, id: current.id };
  }

  it("keeps delivering frames while the page changes", async () => {
    const { targetId } = await launchTarget(tickingPageUrl());
    const frames: WebuiBrowserImageFrame[] = [];
    await provider.startImageStream(targetId, (frame) => {
      frames.push(frame);
    });

    await new Promise((resolve) => setTimeout(resolve, WATCH_MS));

    // A stream that is acknowledged keeps coming. One that is not delivers the
    // first frame and then stops, and the page freezes on it.
    expect(frames.length).toBeGreaterThan(1);
    // And the sequence moves, so the frames are new rather than repeated.
    expect(frames[frames.length - 1].sequence).toBeGreaterThan(frames[0].sequence);
    // Every frame is about the page that asked for it.
    expect(frames.every((frame) => frame.target.targetId === targetId)).toBe(true);
  });

  it("the window takes the size the panel shows the page at", async () => {
    // The browser is a window, and a window is the size of the place it is
    // shown in. A page drawn into a surface of another shape is scaled down,
    // and the person reads it at half the size — so the panel states the size
    // it shows the page at, and the browser takes it.
    const { id, targetId } = await launchTarget(buttonPageUrl());
    await provider.setViewport(targetId, { width: 600, height: 820 });

    const size = (await provider.sendCommand(id, "Runtime.evaluate", {
      expression: "JSON.stringify([window.innerWidth, window.innerHeight])",
      returnByValue: true,
    })) as { result?: { value?: unknown } } | undefined;
    expect(size?.result?.value).toBe(JSON.stringify([600, 820]));
  });

  it("a click mapped into the picture lands where the person pointed", async () => {
    // The picture is the browser's viewport drawn to fit the surface. A click
    // on the surface is therefore not yet a point in the browser, and this is
    // the whole chain: a point on the surface, mapped into the picture, sent
    // to the browser, and the page reacts.
    const { id, targetId } = await launchTarget(buttonPageUrl());
    const picture = { naturalWidth: 1280, naturalHeight: 800 };
    // The surface the panel shows the picture on: half the viewport's width.
    const surface = { left: 0, top: 0, width: 640, height: 400 };
    // The point on the surface that lands on the button, which sits at
    // (100..300, 80..140) in the viewport.
    const onSurface = webuiBrowserPicturePoint(surface, picture, 200 * 0.5, 110 * 0.5);
    expect(onSurface.x).toBeCloseTo(200);
    expect(onSurface.y).toBeCloseTo(110);

    await provider.sendInput({
      kind: "pointer",
      action: "press",
      target: id,
      x: onSurface.x,
      y: onSurface.y,
      button: "left",
    });
    await provider.sendInput({
      kind: "pointer",
      action: "release",
      target: id,
      x: onSurface.x,
      y: onSurface.y,
      button: "left",
    });
    await new Promise((resolve) => setTimeout(resolve, 300));

    const clicked = (await provider.sendCommand(id, "Runtime.evaluate", {
      expression: "document.getElementById('log').textContent",
      returnByValue: true,
    })) as { result?: { value?: unknown } } | undefined;
    expect(clicked?.result?.value).toBe("clicked");
    expect(targetId).toBeTruthy();
  });
});
