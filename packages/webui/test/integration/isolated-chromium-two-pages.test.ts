// Two pages of one isolated Chromium.
//
// The provider holds one page per web tab. This suite proves the four things
// that follow from that, against a real browser:
//
//   * two pages can be driven, streamed and input into independently;
//   * a navigation on one page advances that page's generation and leaves the
//     other page's alone;
//   * a reference recorded against a page's previous generation is refused on
//     every page, not only on the one the browser was launched with;
//   * a frame is delivered to the page that asked for it and to no other.
//
// The last suite is the toolbar the web tab carries: back, forward, reload and
// a read-only url, pressed against a real page through the same operation the
// client sends through.
//
// The frames are the sharpest of the four. A provider that stamped every
// screencast frame with its own target would still deliver *a* picture to
// every subscriber — the wrong one. Only the envelope's session id says which
// page a frame is about, so only a subscriber that receives its own page's
// frames proves the routing.
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
import { WebuiBrowserService } from "../../src/runtime/browser/browser-service.js";
import { createWebuiBrowserToolAdapter } from "../../src/runtime/browser/tool-adapter.js";
import type { WebuiBrowserPort } from "../../src/runtime/port.js";
import {
  webuiBrowserToolbarRun,
  type WebuiBrowserToolbarCommand,
} from "../../src/client/features/browser/ui/BrowserPanelHost.public.js";
import {
  SEND_BROWSER_COMMAND_OPERATION_NAME,
  SEND_BROWSER_INPUT_OPERATION_NAME,
} from "../../src/shared/operation-names.js";
import { prepareWebuiBrowserInputCommand } from "../../src/client/features/browser/application/browser-commands.js";
import { createBrowserHandlerEntries } from "../../src/server/operation/handlers/browser.js";
import type {
  WebuiBrowserAuthorization,
  WebuiBrowserCommandRequest,
  WebuiBrowserImageFrame,
  WebuiBrowserTargetId,
} from "../../src/shared/contracts/browser.js";

/** A page with a field and a title, so two pages can be told apart. */
function pageHtml(title: string): string {
  return [
    `<!doctype html><title>${title}</title>`,
    "<input id='field' type='text'>",
    "<script>",
    "document.getElementById('field').addEventListener('input', (event) => {",
    "  document.title = 'text:' + event.target.value;",
    "});",
    "</script>",
  ].join("\n");
}

/** The data URL of a page with the given title. */
function pageUrl(title: string): string {
  return `data:text/html,${encodeURIComponent(pageHtml(title))}`;
}

/**
 * The budget every case in this file is given.
 *
 * Every case here drives a real browser, so the budget is not a statement
 * about what the case may take — it is room for a runner that is several
 * times slower than the machine the numbers were measured on, so that a slow
 * machine cannot report a red that says nothing about the product. What is
 * correct and what is not is decided by `WAIT_MS`: a case whose page never
 * reaches the state it asserts fails at that deadline, with the state it was
 * waiting for named, and the budget is never what catches it.
 *
 * The budget therefore has to cover the case's waits *and* the work around
 * them. The case that waits most often waits seven times, and every one of
 * those waits ends at `WAIT_MS`, so the largest sum of wait deadlines in
 * this file is 21s. The macOS CI run — the whole 213-file webui group at
 * once — measured the slowest of these cases at 5015ms, so 21s of waits
 * plus that work is about 26s, and 30s would leave 4s between a slow
 * machine and a red that says nothing. 60s is the number the repository
 * already gives a gate that drives a real process
 * (`webui-dependency-check.test.ts`), and it leaves the round trips to a
 * real browser about 8x the time the CI run measured them.
 */
const BROWSER_CASE_BUDGET_MS = 60_000;

/** How often a page is asked whether it has reached the state a case waits for. */
const POLL_MS = 50;

/**
 * How long a page is given to reach the state a case waits for.
 *
 * Every wait in this file is a condition rather than a pause, so this is a
 * deadline on the condition and not a delay: a page that never gets there
 * fails the case here, with the state it was waiting for named. It is an
 * order of magnitude below the budget the case is given, and it is the
 * budget's own rule that a failure is always the condition's and never the
 * budget's.
 *
 * The longest wait a healthy page took here was about 200ms, so this is
 * roughly fifteen times the time a page needs. A case may wait several
 * times, so the budget covers the sum of those deadlines — not this one.
 */
const WAIT_MS = 3_000;

/**
 * Waits for a condition to hold.
 *
 * The condition is asked again every `POLL_MS` until it holds. A condition
 * that throws is the page's own state rather than the flow's failure — a
 * page that is loading answers a read with an error — so it is asked again,
 * and the last of those errors is reported if the wait ends without the
 * condition holding.
 *
 * The wait never passes a condition that did not hold: it ends in a failure,
 * not in a quiet success.
 */
async function waitFor(
  condition: () => boolean | Promise<boolean>,
  description: string,
): Promise<void> {
  const deadline = Date.now() + WAIT_MS;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      if (await condition()) return;
      lastError = undefined;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
  throw new Error(
    `timed out waiting for ${description}${lastError === undefined ? "" : `: ${String(lastError)}`}`,
  );
}

async function chromeIsAvailable(): Promise<boolean> {
  return (await resolveChromePath()) !== undefined;
}

async function resolveChromePath(): Promise<string | undefined> {
  const { access } = await import("node:fs/promises");
  const candidates =
    process.platform === "darwin"
      ? [
          "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
          "/Applications/Chromium.app/Contents/MacOS/Chromium",
          "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
        ]
      : [
          "/usr/bin/google-chrome",
          "/usr/bin/google-chrome-stable",
          "/usr/bin/chromium",
          "/usr/bin/chromium-browser",
        ];
  for (const candidate of candidates) {
    try {
      await access(candidate);
      return candidate;
    } catch {
      // Keep looking.
    }
  }
  return undefined;
}

const available = await chromeIsAvailable();

describe.skipIf(!available)("the isolated Chromium, one page per web tab", () => {
  let dataDir: string;
  let provider: WebuiIsolatedChromiumProvider;

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "webui-isolated-two-pages-"));
    provider = await WebuiIsolatedChromiumProvider.launch({ dataDir });
  }, 60_000);

  afterAll(async () => {
    await provider?.close();
    if (dataDir) await rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  /** The identity of the page the browser was launched with. */
  async function launchTarget(): Promise<WebuiBrowserTargetId> {
    const selected = (await provider.listTargets()).find((entry) => entry.selected);
    if (!selected) throw new Error("the provider reported no selected target");
    return selected.id;
  }

  /**
   * Opens a second page and returns its identity.
   *
   * The page is opened through the provider's own `open_tab`, so the test
   * exercises the same path the Agent's tool uses.
   */
  async function openPage(title: string): Promise<WebuiBrowserTargetId> {
    const opened = (await provider.sendCommand(await launchTarget(), "open_tab", {
      url: pageUrl(title),
    })) as { targetId?: string } | undefined;
    const targetId = opened?.targetId;
    if (!targetId) throw new Error("open_tab returned no target");
    // The page is created by the browser before the provider has registered
    // it, so the wait is for the page to be listed rather than for a fixed
    // span of time: the listing is what says the provider drives it.
    await waitFor(
      async () =>
        (await provider.listTargets()).some((entry) => entry.id.targetId === targetId),
      "the new page to appear in the target list",
    );
    const state = (await provider.listTargets()).find((entry) => entry.id.targetId === targetId);
    if (!state) throw new Error("the new page is not in the target list");
    // The page is listed before its document has loaded, so the title is
    // waited for as well: a title read too early is the empty one, and the
    // case would read that as a page that is not the one it opened.
    await waitFor(
      async () => (await readTitle(state.id)) === title,
      "the new page to load",
    );
    return state.id;
  }

  /** The generation the provider currently holds for a page. */
  async function generationOf(targetId: string): Promise<number> {
    const found = (await provider.listTargets()).find((entry) => entry.id.targetId === targetId);
    if (!found) throw new Error("the page is not in the target list");
    return found.id.generation;
  }

  /** The title the page behind the target is showing. */
  async function readTitle(target: WebuiBrowserTargetId): Promise<string> {
    const result = (await provider.sendCommand(target, "Runtime.evaluate", {
      expression: "document.title",
      returnByValue: true,
    })) as { result?: { value?: unknown } } | undefined;
    return typeof result?.result?.value === "string" ? result.result.value : "";
  }

  /** The value of the page's field. */
  async function readField(target: WebuiBrowserTargetId): Promise<string> {
    const result = (await provider.sendCommand(target, "Runtime.evaluate", {
      expression: "document.getElementById('field').value",
      returnByValue: true,
    })) as { result?: { value?: unknown } } | undefined;
    return typeof result?.result?.value === "string" ? result.result.value : "";
  }

  /** The field's centre, in page coordinates. */
  async function fieldCentre(target: WebuiBrowserTargetId): Promise<{ x: number; y: number }> {
    const result = (await provider.sendCommand(target, "Runtime.evaluate", {
      expression:
        "(() => { const r = document.getElementById('field').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()",
      returnByValue: true,
    })) as { result?: { value?: unknown } } | undefined;
    const value = result?.result?.value as { x?: number; y?: number } | undefined;
    return { x: value?.x ?? 0, y: value?.y ?? 0 };
  }

  /** Clicks the page's field and types into it. */
  async function typeInto(target: WebuiBrowserTargetId, text: string): Promise<void> {
    // The field is emptied first: the launch page is shared by the cases in
    // this suite, and a field that still held the previous case's text would
    // make the assertion about the *new* text read as a failure.
    await provider.sendCommand(target, "Runtime.evaluate", {
      expression: "document.getElementById('field').value = ''",
    });
    const centre = await fieldCentre(target);
    await provider.sendInput({
      kind: "pointer",
      target,
      x: centre.x,
      y: centre.y,
      button: "left",
      clickCount: 1,
    });
    await provider.sendInput({ kind: "text", target, text });
    // The text is waited for as the value it is, not as "the page changed":
    // the browser delivers the keystrokes to the page on its own schedule, so
    // a read taken right after the send can still see the field as it was —
    // and a keystroke that is still on its way lands in the *next* case's
    // text, which is how a field ends up holding two texts at once.
    await waitFor(
      async () => (await readField(target)) === text,
      `the field to hold ${JSON.stringify(text)}`,
    );
  }

  it("drives, streams and inputs into two pages independently", { timeout: BROWSER_CASE_BUDGET_MS }, async () => {
    const first = await launchTarget();
    const second = await openPage("second page");

    expect(second.targetId).not.toBe(first.targetId);

    // Each page is driven on its own. The navigation replaces the page behind
    // the tab, so the identity is read again afterwards: the one read before
    // the navigation is stale by then, and that is the point.
    await provider.sendCommand(first, "Page.navigate", { url: pageUrl("first page") });
    await waitFor(
      async () => (await readTitle(first)) === "first page",
      "the first page to load",
    );
    const firstAfterNavigation = await launchTarget();
    expect(await readTitle(firstAfterNavigation)).toBe("first page");
    expect(await readTitle(second)).toBe("second page");

    // Each page is input into on its own.
    await typeInto(firstAfterNavigation, "alpha");
    await typeInto(second, "bravo");
    expect(await readField(firstAfterNavigation)).toBe("alpha");
    expect(await readField(second)).toBe("bravo");
  });

  it("advances one page's generation and leaves the other's alone", { timeout: BROWSER_CASE_BUDGET_MS }, async () => {
    const first = await launchTarget();
    const second = await openPage("generation page");

    const before = new Map<string, number>();
    for (const target of await provider.listTargets()) {
      before.set(target.id.targetId, target.id.generation);
    }

    await provider.sendCommand(second, "Page.navigate", { url: pageUrl("navigated page") });
    await waitFor(
      async () => (await generationOf(second.targetId)) > (before.get(second.targetId) ?? 0),
      "the navigated page to advance its generation",
    );

    const after = new Map<string, number>();
    for (const target of await provider.listTargets()) {
      after.set(target.id.targetId, target.id.generation);
    }

    // The navigated page advanced.
    expect(after.get(second.targetId)).toBe((before.get(second.targetId) ?? 0) + 1);
    // The page that did not navigate did not.
    expect(after.get(first.targetId)).toBe(before.get(first.targetId));
  });

  it("refuses a stale reference on every page, not only the launch page", { timeout: BROWSER_CASE_BUDGET_MS }, async () => {
    const first = await launchTarget();
    const second = await openPage("fenced page");

    const secondBefore = second.generation;
    await provider.sendCommand(second, "Page.navigate", { url: pageUrl("fenced page two") });
    await waitFor(
      async () => (await generationOf(second.targetId)) > secondBefore,
      "the navigated page to advance its generation",
    );

    // The stale identity of the page that was navigated.
    await expect(
      provider.sendInput({ kind: "text", target: second, text: "must not arrive" }),
    ).rejects.toMatchObject({ code: "browser_target_stale" });

    // The launch page's own current identity still works, so the fence did not
    // simply break every input.
    await typeInto(first, "still works");
    expect(await readField(first)).toBe("still works");
  });

  it("answers open_tab with the identity of the page it created", { timeout: BROWSER_CASE_BUDGET_MS }, async () => {
    const launch = await launchTarget();

    const opened = (await provider.sendCommand(launch, "open_tab", {
      url: pageUrl("opened page"),
    })) as WebuiBrowserTargetId;

    // The answer names the page that was created: the surface, the browser,
    // the target and the generation.
    expect(opened.surface).toBe("isolated-chromium");
    expect(opened.browserId).toBe(provider.browserId);
    expect(typeof opened.targetId).toBe("string");
    expect(typeof opened.generation).toBe("number");

    // The page appears in the provider's target list under that identity.
    await waitFor(
      async () =>
        (await provider.listTargets()).some((entry) => entry.id.targetId === opened.targetId),
      "the new page to appear in the target list",
    );
    const listed = (await provider.listTargets()).find(
      (entry) => entry.id.targetId === opened.targetId,
    );
    expect(listed?.id.surface).toBe(opened.surface);
    expect(listed?.id.browserId).toBe(opened.browserId);
    expect(listed?.id.targetId).toBe(opened.targetId);

    // The page the answer names is a page that can be driven. The generation
    // is read from the list rather than from the answer: a page that is still
    // loading is observed as a replaced page once its first load lands, and
    // that is the generation the provider holds afterwards.
    const current = listed!.id;
    await provider.sendCommand(current, "Page.navigate", { url: pageUrl("driven page") });
    await waitFor(
      async () => (await readTitle(current)) === "driven page",
      "the driven page to load",
    );
    expect(await readTitle(current)).toBe("driven page");
  });

  it("delivers a frame to the page that asked for it and to no other", { timeout: BROWSER_CASE_BUDGET_MS }, async () => {
    const first = await launchTarget();
    const second = await openPage("streamed page");

    const firstFrames: WebuiBrowserImageFrame[] = [];
    const secondFrames: WebuiBrowserImageFrame[] = [];

    // Chrome renders the foregrounded tab and throttles the others, so the
    // provider brings the page it is streaming to the front. The first page is
    // streamed and driven first, and the second one after it, so each page's
    // frames are produced while that page is the one on screen.
    await provider.startImageStream(first.targetId, (frame) => firstFrames.push(frame));
    await typeInto(first, "one");
    await waitFor(() => firstFrames.length > 0, "a frame of the first page");

    await provider.startImageStream(second.targetId, (frame) => secondFrames.push(frame));
    await typeInto(second, "two");
    await waitFor(() => secondFrames.length > 0, "a frame of the second page");

    expect(firstFrames.length).toBeGreaterThan(0);
    expect(secondFrames.length).toBeGreaterThan(0);

    // Every frame went to the page it belongs to, and to no other. This is
    // what the envelope's session id buys: a provider that stamped every
    // frame with its own target would still deliver a picture to both
    // subscribers — the wrong one.
    expect(firstFrames.every((frame) => frame.target.targetId === first.targetId)).toBe(true);
    expect(secondFrames.every((frame) => frame.target.targetId === second.targetId)).toBe(true);

    // A frame's sequence number counts that page's frames, not the browser's.
    expect(firstFrames.map((frame) => frame.sequence)).toEqual(
      firstFrames.map((_frame, index) => index + 1),
    );
    expect(secondFrames.map((frame) => frame.sequence)).toEqual(
      secondFrames.map((_frame, index) => index + 1),
    );

    await provider.stopImageStream(first.targetId);
    await provider.stopImageStream(second.targetId);
  });
});

/**
 * The service, streaming two pages of one real Chromium.
 *
 * The provider-level suite above proves the pages are independent. This one
 * proves the *streams* are: the client asks for the page it is showing, and
 * two streams open at once must not cross.
 */
describe.skipIf(!available)("the browser service, streaming two pages of one Chromium", () => {
  let dataDir: string;
  let service: WebuiBrowserService;

  const authorization: WebuiBrowserAuthorization = {
    isolatedChromium: true,
    edge: false,
    chrome: false,
    // The raw DevTools method below is how the test repaints a page, and the
    // Full CDP switch is what allows a raw method through.
    fullCdp: true,
  };

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "webui-two-page-streams-"));
    service = new WebuiBrowserService({
      authorization: {
        read: async () => authorization,
        write: async () => authorization,
      },
      dataDir,
    });
  }, 60_000);

  afterAll(async () => {
    await service?.close();
    if (dataDir) await rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  /** The value an expression has on the page the run has selected. */
  async function readSelection(expression: string): Promise<unknown> {
    const read = (await service.sendCommandToSelection(
      "isolated-chromium",
      "run-1",
      "Runtime.evaluate",
      { expression, returnByValue: true },
    )) as { result?: { result?: { value?: unknown } } } | undefined;
    return read?.result?.result?.value;
  }

  /** Repaints the page the run is on, which is what makes the screencast push. */
  async function repaint(): Promise<void> {
    await service.sendCommandToSelection("isolated-chromium", "run-1", "Runtime.evaluate", {
      expression: "document.body.style.background = 'rgb(12, 34, 56)'",
    });
    // The wait is for the paint to reach the page rather than for a fixed
    // span of time: the screencast pushes when the page has changed, so a
    // repaint that had not landed yet would produce no frame at all.
    await waitFor(
      async () => (await readSelection("document.body.style.background")) === "rgb(12, 34, 56)",
      "the repaint to reach the page",
    );
  }

  it("gives two tabs their own pictures, and neither receives the other's frames", { timeout: BROWSER_CASE_BUDGET_MS }, async () => {
    const list = await service.listTargets("isolated-chromium", "run-1");
    // The service marks the *run's* selection, and the run has not selected
    // anything yet, so the page to start from is found by asking the provider
    // which of the listed pages it can actually drive: the browser opens a
    // page of its own that the provider never attached to.
    let first: WebuiBrowserTargetId | undefined;
    for (const candidate of list.targets) {
      await service.selectTarget(candidate.id, "run-1");
      try {
        await service.sendCommandToSelection("isolated-chromium", "run-1", "Runtime.evaluate", {
          expression: "1",
        });
        first = candidate.id;
        break;
      } catch {
        // This page is not one the provider drives; try the next.
      }
    }
    expect(first).toBeDefined();

    // The run opens a second tab, so the session owns two pages.
    const opened = await service.sendCommandToSelection(
      "isolated-chromium",
      "run-1",
      "open_tab",
      { url: pageUrl("second page") },
    );
    const secondTab = opened.result as WebuiBrowserTargetId;
    expect(secondTab.targetId).not.toBe(first!.targetId);

    const firstFrames: WebuiBrowserImageFrame[] = [];
    const secondFrames: WebuiBrowserImageFrame[] = [];
    const controller = new AbortController();
    const firstStream = (async () => {
      for await (const frame of service.watchFrames(
        "isolated-chromium",
        first!,
        controller.signal,
      )) {
        firstFrames.push(frame);
      }
    })();

    // Chrome renders the page in front and throttles the ones behind it, and
    // the provider brings the page it streams to the front. A page that is
    // behind another one therefore produces no picture at all, so each page
    // is watched while it is the one on screen: the first page's stream is
    // opened and its picture waited for, and only then is the second page's
    // stream opened. Both streams are open at once from that point on, which
    // is what the crossing below is about — the first page's stream is open
    // while the second page's pictures arrive.
    await repaint();
    await waitFor(() => firstFrames.length > 0, "a picture of the first page");

    // The page behind a new tab lands its first load after the tab was
    // opened, and the provider reads that landing as a replaced page: the
    // generation moves with it, and the identity `open_tab` answered with is a
    // generation behind by the time the row gets to use it. The service
    // refuses such an identity and says what to do about it — select the
    // target again — so the row reads the identity the service holds for the
    // tab, selects that one, and watches that one.
    let second: WebuiBrowserTargetId | undefined;
    await waitFor(async () => {
      const listed = await service.listTargets("isolated-chromium", "run-1");
      const current = listed.targets.find(
        (candidate) => candidate.id.targetId === secondTab.targetId,
      );
      if (!current) return false;
      await service.selectTarget(current.id, "run-1");
      second = current.id;
      return true;
    }, "the second page to become the run's selection");

    const secondStream = (async () => {
      for await (const frame of service.watchFrames(
        "isolated-chromium",
        second!,
        controller.signal,
      )) {
        secondFrames.push(frame);
      }
    })();
    await repaint();
    await waitFor(() => secondFrames.length > 0, "a picture of the second page");

    controller.abort();
    await Promise.allSettled([firstStream, secondStream]);

    expect(firstFrames.length).toBeGreaterThan(0);
    expect(secondFrames.length).toBeGreaterThan(0);
    // Neither stream received the other page's picture.
    expect(firstFrames.every((frame) => frame.target.targetId === first!.targetId)).toBe(true);
    expect(secondFrames.every((frame) => frame.target.targetId === secondTab.targetId)).toBe(true);
  });
});

/**
 * The Agent's own path, against a real isolated Chromium.
 *
 * A cold run has selected nothing, and `open_tab` is the one action it may
 * perform: it is the action that would create the selection the gate wants.
 * The page it opens is then the run's page, and the run can drive it.
 */
describe.skipIf(!available)("the Agent opening a tab of a real isolated Chromium", () => {
  let dataDir: string;
  let service: WebuiBrowserService;

  const authorization: WebuiBrowserAuthorization = {
    isolatedChromium: true,
    edge: false,
    chrome: false,
    // The raw DevTools method below reads the page back, and the Full CDP
    // switch is what allows a raw method through.
    fullCdp: true,
  };

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "webui-agent-opens-tab-"));
    service = new WebuiBrowserService({
      authorization: {
        read: async () => authorization,
        write: async () => authorization,
      },
      dataDir,
    });
  }, 60_000);

  afterAll(async () => {
    await service?.close();
    if (dataDir) await rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  /** The title the page the run has selected is showing. */
  async function readSelectionTitle(): Promise<string> {
    const read = (await service.sendCommandToSelection(
      "isolated-chromium",
      "run-1",
      "Runtime.evaluate",
      { expression: "document.title", returnByValue: true },
    )) as { result?: { result?: { value?: string } } };
    return read.result?.result?.value ?? "";
  }

  it("opens a page the same run can then navigate", { timeout: BROWSER_CASE_BUDGET_MS }, async () => {
    const adapter = createWebuiBrowserToolAdapter({ browser: service });
    const context = { sessionId: "run-1" } as never;

    // The run has selected nothing, and it is refused everything — except the
    // action that creates a selection.
    await expect(
      adapter.execute(context, "navigate", { url: pageUrl("refused") }),
    ).rejects.toMatchObject({ code: "browser_target_unknown" });

    const opened = (await adapter.execute(context, "open_tab", {
      url: pageUrl("agent page"),
    })) as WebuiBrowserTargetId;
    expect(opened.targetId).toEqual(expect.any(String));

    // The run's selection is the page it opened, and the run can drive it.
    const list = await service.listTargets("isolated-chromium", "run-1");
    expect(list.targets.find((entry) => entry.selected)?.id.targetId).toBe(
      opened.targetId,
    );

    await adapter.execute(context, "navigate", { url: pageUrl("driven by the agent") });
    // The wait is for the page to be the one the run navigated rather than
    // for a fixed span of time after the navigation was asked for.
    await waitFor(
      async () => (await readSelectionTitle()) === "driven by the agent",
      "the navigated page to load",
    );

    // The page behind the tab is the one the run navigated.
    const read = (await service.sendCommandToSelection(
      "isolated-chromium",
      "run-1",
      "Runtime.evaluate",
      { expression: "document.title", returnByValue: true },
    )) as { result?: { result?: { value?: string } } };
    expect(read.result?.result?.value).toBe("driven by the agent");
  });
});

/**
 * The web tab's toolbar, against a real page.
 *
 * The toolbar is three presses and a line of text, and neither half is worth
 * believing until it has moved a real page. This drives it the way the person
 * does — the client's own helper builds the request, the operation's own
 * validator and handler carry it, the service fences it and the isolated
 * Chromium executes it — so what is proved is the whole path rather than a
 * component in isolation:
 *
 *   * `navigate` gives the page a history, then `back` and `forward` walk it
 *     and land on the pages they name;
 *   * `reload` re-reads the page it is on;
 *   * the generation follows each move, so the reference recorded before one is
 *     refused with `browser_target_stale` — and the tab's current reference is
 *     accepted, so the fence refuses the stale one and not the toolbar;
 *   * a move the page's history cannot make is refused with the provider's own
 *     `browser_capability_denied`, and the page is untouched.
 *
 * The client helper is imported from the browser business on purpose: the path
 * under test is the one the shipped toolbar takes, not a re-statement of it.
 */
describe.skipIf(!available)("the web tab's toolbar, on a real page", () => {
  let dataDir: string;
  let service: WebuiBrowserService;

  const authorization: WebuiBrowserAuthorization = {
    isolatedChromium: true,
    edge: false,
    chrome: false,
    // Reading the title back is a raw DevTools method, and the Full CDP switch
    // is what allows it through.
    fullCdp: true,
  };

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "webui-web-tab-toolbar-"));
    service = new WebuiBrowserService({
      authorization: {
        read: async () => authorization,
        write: async () => authorization,
      },
      dataDir,
    });
  }, 60_000);

  afterAll(async () => {
    await service?.close();
    if (dataDir) await rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  /**
   * The operation the toolbar sends through, as the wire sees it.
   *
   * The handler is the server's own: validation and routing included, so the
   * test fails if the target ever stops being routed to the page it names.
   */
  async function sendCommand(request: WebuiBrowserCommandRequest): Promise<unknown> {
    const entry = createBrowserHandlerEntries(service as unknown as WebuiBrowserPort).get(
      SEND_BROWSER_COMMAND_OPERATION_NAME,
    );
    if (!entry) throw new Error("sendBrowserCommand has no handler");
    const validated = entry.operation.validate(request);
    if (!validated.ok) throw new Error(validated.message);
    const result = await entry.handle({ requestId: "toolbar" }, validated.body);
    return (result as { readonly body: { readonly result?: unknown } }).body.result;
  }

  /** One toolbar press, through the client helper and the wire. */
  async function pressToolbar(
    target: WebuiBrowserTargetId,
    command: WebuiBrowserToolbarCommand,
  ): Promise<void> {
    await webuiBrowserToolbarRun({ send: sendCommand, target, command });
  }

  /** The tab's current identity, as the runtime's web-tab snapshot publishes it. */
  async function currentTab(target: WebuiBrowserTargetId): Promise<WebuiBrowserTargetId> {
    const list = await service.listTargets("isolated-chromium");
    const found = list.targets.find((entry) => entry.id.targetId === target.targetId);
    if (!found) throw new Error("the web tab is not in the target list");
    return found.id;
  }

  /** The title the page behind the tab is showing. */
  async function readTitle(target: WebuiBrowserTargetId): Promise<string> {
    const read = (await sendCommand({
      surface: target.surface,
      command: "Runtime.evaluate",
      params: { expression: "document.title", returnByValue: true },
      target: await currentTab(target),
    })) as { result?: { value?: unknown } } | undefined;
    return typeof read?.result?.value === "string" ? read.result.value : "";
  }

  it("walks a real page's history and re-reads it", { timeout: BROWSER_CASE_BUDGET_MS }, async () => {
    // The person's launcher opens the page, which gives the tab something to
    // show and something to go back to. No run is in view here, so the page is
    // recorded in the panel's own cell.
    const opened = await service.openWebTab(
      undefined,
      { url: pageUrl("toolbar one") },
      undefined,
      "person",
    );
    // Each wait below is for the page to be where this case says it is, so a
    // navigation that did not happen fails the case at the wait and with the
    // state it was waiting for named — not after a fixed pause.
    await waitFor(
      async () => (await readTitle(opened.target)) === "toolbar one",
      "the first page to load",
    );
    let tab = await currentTab(opened.target);

    // The page moves: the Agent's `navigate`, sent through the same operation
    // the toolbar sends through, naming the page it acts on.
    await sendCommand({
      surface: tab.surface,
      command: "navigate",
      params: { url: pageUrl("toolbar two") },
      target: tab,
    });
    await waitFor(
      async () => (await readTitle(tab)) === "toolbar two",
      "the second page to load",
    );
    tab = await currentTab(tab);
    expect(await readTitle(tab)).toBe("toolbar two");

    // Back lands on the page it came from.
    await pressToolbar(tab, "back");
    await waitFor(
      async () => (await readTitle(tab)) === "toolbar one",
      "the back navigation to land",
    );
    const afterBack = await currentTab(tab);
    expect(await readTitle(afterBack)).toBe("toolbar one");

    // Forward lands on the one it left.
    await pressToolbar(afterBack, "forward");
    await waitFor(
      async () => (await readTitle(tab)) === "toolbar two",
      "the forward navigation to land",
    );
    const afterForward = await currentTab(afterBack);
    expect(await readTitle(afterForward)).toBe("toolbar two");

    // Reload re-reads the page it is on, and the title follows the page rather
    // than the press: it is still the page the tab holds. The wait is for the
    // page's generation to move, because that is what says the document was
    // read again — the title alone cannot tell a reload from the page before
    // it.
    const beforeReload = afterForward.generation;
    await pressToolbar(afterForward, "reload");
    await waitFor(
      async () => (await currentTab(afterForward)).generation > beforeReload,
      "the reload to read the page again",
    );
    // The generation moves when the navigation starts, and the document is
    // read again after it, so the title is waited for as well: read in
    // between, it is the title of the document being replaced.
    await waitFor(
      async () => (await readTitle(afterForward)) === "toolbar two",
      "the reloaded page to show its title",
    );
    const afterReload = await currentTab(afterForward);
    expect(afterReload.targetId).toBe(afterForward.targetId);
    expect(await readTitle(afterReload)).toBe("toolbar two");
  });

  it("follows the page's generation, so a reference recorded before a move is refused", { timeout: BROWSER_CASE_BUDGET_MS }, async () => {
    const opened = await service.openWebTab(
      undefined,
      { url: pageUrl("generation one") },
      undefined,
      "person",
    );
    await waitFor(
      async () => (await readTitle(opened.target)) === "generation one",
      "the first page to load",
    );
    const recorded = await currentTab(opened.target);

    await sendCommand({
      surface: recorded.surface,
      command: "navigate",
      params: { url: pageUrl("generation two") },
      target: recorded,
    });
    // The move has to have landed before the reference can be stale, so the
    // wait is for the page's generation to advance rather than for a pause.
    await waitFor(
      async () => (await currentTab(recorded)).generation > recorded.generation,
      "the navigation to replace the page",
    );

    // The move advanced the page, so the reference the toolbar was holding is
    // stale and is refused rather than answered against the page that moved.
    await expect(pressToolbar(recorded, "reload")).rejects.toMatchObject({
      code: "browser_target_stale",
    });

    // The tab's current reference — the one the runtime's snapshot publishes —
    // still works, so the fence refuses the stale one and not the toolbar.
    const current = await currentTab(recorded);
    expect(current.generation).toBeGreaterThan(recorded.generation);
    await pressToolbar(current, "reload");
    await waitFor(
      async () => (await currentTab(current)).generation > current.generation,
      "the reload to read the page again",
    );
    // The generation moves when the navigation starts, so the title is
    // waited for as well: read in between, it is the title of the document
    // being replaced.
    await waitFor(
      async () => (await readTitle(current)) === "generation two",
      "the reloaded page to show its title",
    );
    expect(await readTitle(current)).toBe("generation two");
  });

  it("refuses a move the page's history cannot make, with the provider's own code", { timeout: BROWSER_CASE_BUDGET_MS }, async () => {
    const opened = await service.openWebTab(
      undefined,
      { url: pageUrl("nowhere to go") },
      undefined,
      "person",
    );
    await waitFor(
      async () => (await readTitle(opened.target)) === "nowhere to go",
      "the page to load",
    );
    const tab = await currentTab(opened.target);
    const before = await readTitle(tab);

    // A freshly opened page has nothing in front of it. `back` says so with the
    // refusal it already has rather than pretending, and the page is untouched.
    await expect(pressToolbar(tab, "back")).rejects.toMatchObject({
      code: "browser_capability_denied",
    });
    expect(await readTitle(await currentTab(tab))).toBe(before);
  });
});

/**
 * The two cells, against a real isolated Chromium.
 *
 * The run's selection is the runtime's and the page in front is the client's, one
 * writer each (ADR 0022). Everything below runs the shipped paths rather than the
 * service's own API: the Agent acts through `sendCommandToSelection` and its
 * adapter, the person's gesture is built by the client's own binding function and
 * carried by the `sendBrowserInput` handler, and both are read back out of the
 * pages themselves. A fake would be free to agree with whatever the reducer says;
 * a browser is not.
 *
 * Two facts are worth a real browser each:
 *
 *   * the Agent works in one tab while the person types in another, and each page
 *     ends up holding exactly its own input — neither cell reaches the other's page;
 *   * on one page, both are delivered, and an input recorded before the Agent's
 *     navigation is *refused* with the runtime's code rather than dropped in
 *     silence, which is the difference between a fence and a lost keystroke.
 */
describe.skipIf(!available)("the run's selection and the tab in front, on a real browser", () => {
  let dataDir: string;
  let service: WebuiBrowserService;
  let entries: ReturnType<typeof createBrowserHandlerEntries>;

  const authorization: WebuiBrowserAuthorization = {
    isolatedChromium: true,
    edge: false,
    chrome: false,
    // The raw DevTools methods below focus the field and read the pages back,
    // and the Full CDP switch is what allows them through.
    fullCdp: true,
  };

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "webui-two-cells-"));
    service = new WebuiBrowserService({
      authorization: {
        read: async () => authorization,
        write: async () => authorization,
      },
      dataDir,
    });
    // Built here rather than in the describe body: the service is created by the
    // hook, and the handlers are handed the object they will call.
    entries = createBrowserHandlerEntries(service as unknown as WebuiBrowserPort);
  }, 60_000);

  afterAll(async () => {
    await service?.close();
    if (dataDir) await rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  /** The tab's current identity, as the runtime's target list publishes it. */
  async function currentTab(target: WebuiBrowserTargetId): Promise<WebuiBrowserTargetId> {
    const list = await service.listTargets("isolated-chromium");
    const found = list.targets.find((entry) => entry.id.targetId === target.targetId);
    if (!found) throw new Error("the web tab is not in the target list");
    return found.id;
  }

  /** The target the run has selected, or `undefined` when it has selected nothing. */
  async function runSelection(runId = "run-1"): Promise<string | undefined> {
    const list = await service.listTargets("isolated-chromium", runId);
    return list.targets.find((entry) => entry.selected)?.id.targetId;
  }

  /** Runs a raw DevTools method against one named page and reads the answer back. */
  async function evaluate(
    target: WebuiBrowserTargetId,
    expression: string,
  ): Promise<unknown> {
    const entry = entries.get(SEND_BROWSER_COMMAND_OPERATION_NAME);
    if (!entry) throw new Error("sendBrowserCommand has no handler");
    const request: WebuiBrowserCommandRequest = {
      surface: target.surface,
      command: "Runtime.evaluate",
      params: { expression, returnByValue: true },
      target: await currentTab(target),
    };
    const validated = entry.operation.validate(request);
    if (!validated.ok) throw new Error(validated.message);
    const answered = await entry.handle({ requestId: "two-cells" }, validated.body);
    const result = (answered as { readonly body: { readonly result?: { result?: { value?: unknown } } } }).body
      .result;
    return result?.result?.value;
  }

  /** The value of the page's field. */
  async function readField(target: WebuiBrowserTargetId): Promise<string> {
    const value = await evaluate(target, "document.getElementById('field').value");
    return typeof value === "string" ? value : "";
  }

  /** The field's centre, in page coordinates. */
  async function fieldCentre(target: WebuiBrowserTargetId): Promise<{ x: number; y: number }> {
    const value = (await evaluate(
      target,
      "(() => { const r = document.getElementById('field').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()",
    )) as { x?: number; y?: number } | undefined;
    return { x: value?.x ?? 0, y: value?.y ?? 0 };
  }

  /**
   * The person's gesture, built the way the panel builds it.
   *
   * `prepareWebuiBrowserInputCommand` is the client's binding function and it is
   * given the tab the person is looking at — nothing else — so the command can
   * only ever name that page. The send is the `sendBrowserInput` operation, the
   * one the client reaches through the port.
   */
  async function personTypes(
    page: WebuiBrowserTargetId,
    text: string,
    runId = "run-1",
  ): Promise<void> {
    const entry = entries.get(SEND_BROWSER_INPUT_OPERATION_NAME);
    if (!entry) throw new Error("sendBrowserInput has no handler");
    const tab = await currentTab(page);
    const centre = await fieldCentre(tab);
    await evaluate(tab, "document.getElementById('field').value = ''");
    const tap = prepareWebuiBrowserInputCommand(tab, {
      kind: "pointer",
      x: centre.x,
      y: centre.y,
      button: "left",
      clickCount: 1,
    });
    const typed = prepareWebuiBrowserInputCommand(tab, { kind: "text", text });
    if (!tap.ok) throw new Error(`the tap was refused: ${tap.error.message}`);
    if (!typed.ok) throw new Error(`the text was refused: ${typed.error.message}`);
    // The wire envelope is the command itself with the run's id beside it — the
    // client's port call spreads the same fields into the message.
    for (const command of [tap.command, typed.command]) {
      const validated = entry.operation.validate({ ...command, runId });
      if (!validated.ok) throw new Error(validated.message);
      await entry.handle({ requestId: "person" }, validated.body);
    }
    // The text is waited for as the value it is, not as "the page changed":
    // the browser delivers the keystrokes to the page on its own schedule, so
    // a read taken right after the send can still see the field as it was.
    await waitFor(
      async () => (await readField(page)) === text,
      `the field to hold ${JSON.stringify(text)}`,
    );
  }

  /** The Agent's own action on whatever page its run has selected. */
  async function agentRuns(expression: string, runId = "run-1"): Promise<unknown> {
    const answered = await service.sendCommandToSelection(
      "isolated-chromium",
      runId,
      "Runtime.evaluate",
      { expression, returnByValue: true },
    );
    return (answered as { result?: { result?: { value?: unknown } } }).result?.result?.value;
  }

  it("keeps the Agent's page and the person's page apart while both are in use", { timeout: BROWSER_CASE_BUDGET_MS }, async () => {
    // The Agent opens its page: its run's selection is the page it opened.
    const opened = await service.openWebTab("run-1", { url: pageUrl("agent page") });
    await waitFor(
      async () => (await evaluate(opened.target, "document.title")) === "agent page",
      "the Agent's page to load",
    );
    const agentPage = await currentTab(opened.target);
    expect(await runSelection()).toBe(agentPage.targetId);

    // The person opens their own page in the same session. The run already has a
    // page, so the bootstrap does not apply and the Agent stays where it was.
    const personOpened = await service.openWebTab(
      "run-1",
      { url: pageUrl("person page") },
      undefined,
      "person",
    );
    await waitFor(
      async () => (await evaluate(personOpened.target, "document.title")) === "person page",
      "the person's page to load",
    );
    const personPage = await currentTab(personOpened.target);
    expect(personPage.targetId).not.toBe(agentPage.targetId);
    expect(await runSelection()).toBe(agentPage.targetId);

    // The Agent acts on its own page, and the person types on theirs. Neither
    // gesture is aimed at the other's page, and each page ends up with its own.
    await agentRuns("document.title = 'agent acted'");
    await waitFor(
      async () => (await evaluate(agentPage, "document.title")) === "agent acted",
      "the Agent's title to land on the Agent's page",
    );
    await personTypes(personPage, "person typed");
    // The page's own script rewrites its title from the text it received, so
    // the title is the browser saying the input reached this page — which is
    // what the wait is for.
    await waitFor(
      async () => (await evaluate(personPage, "document.title")) === "text:person typed",
      "the typed text to reach the person's page",
    );

    expect(await evaluate(agentPage, "document.title")).toBe("agent acted");
    expect(await readField(agentPage)).toBe("");
    // The page's own script rewrites its title from the text it received, so
    // this title is the browser saying the input event reached *this* page.
    expect(await evaluate(personPage, "document.title")).toBe("text:person typed");
    expect(await readField(personPage)).toBe("person typed");
    // The Agent's next action still lands on the Agent's page, and nothing the
    // person did moved it.
    expect(await runSelection()).toBe(agentPage.targetId);
  });

  it("delivers both on one page, and refuses a stale input rather than dropping it", { timeout: BROWSER_CASE_BUDGET_MS }, async () => {
    // A second run, which has selected nothing. The page the person opens is
    // therefore bootstrapped into its selection — the one write that crosses from
    // the client's cell to the runtime's, and it is decided here by the runtime.
    const opened = await service.openWebTab(
      "run-2",
      { url: pageUrl("shared page") },
      undefined,
      "person",
    );
    await waitFor(
      async () => (await evaluate(opened.target, "document.title")) === "shared page",
      "the shared page to load",
    );
    const shared = await currentTab(opened.target);
    expect(await runSelection("run-2")).toBe(shared.targetId);

    // The person types on that page and the Agent acts on the same page. Neither
    // is a cancel of the other: both land, and both are visible in the page.
    await personTypes(shared, "both delivered", "run-2");
    // The page's own script rewrites its title from the text it received, and
    // that rewrite is the browser's own answer to the input. It is waited for
    // before the Agent writes the title, so the two writes cannot land in the
    // other order and leave the page showing the wrong title.
    await waitFor(
      async () => (await evaluate(shared, "document.title")) === "text:both delivered",
      "the typed text to reach the shared page",
    );
    await agentRuns("document.title = 'agent acted'", "run-2");
    await waitFor(
      async () => (await evaluate(shared, "document.title")) === "agent acted",
      "the Agent's title to land on the shared page",
    );
    expect(await readField(shared)).toBe("both delivered");
    expect(await evaluate(shared, "document.title")).toBe("agent acted");

    // The person moves their own page with the tab's toolbar. An input recorded
    // before that move is now stale — and the runtime refuses it with its own
    // code rather than swallowing the keystroke, which is the difference between a
    // fence and a lost character.
    const recorded = await currentTab(shared);
    await evaluate(recorded, "location.href = 'about:blank'");
    // The input below is stale only once the move has landed, so the wait is
    // for the page's generation to advance rather than for a pause.
    await waitFor(
      async () => (await currentTab(recorded)).generation > recorded.generation,
      "the page to move",
    );
    const late = prepareWebuiBrowserInputCommand(recorded, { kind: "text", text: "too late" });
    expect(late).toMatchObject({ ok: true });
    if (!late.ok) return;
    const entry = entries.get(SEND_BROWSER_INPUT_OPERATION_NAME);
    const validated = entry?.operation.validate({ ...late.command, runId: "run-2" });
    expect(validated?.ok).toBe(true);
    await expect(
      entry?.handle({ requestId: "stale" }, validated?.ok ? validated.body : {}),
    ).rejects.toMatchObject({ code: "browser_target_stale" });

    // The page in front is still the tab's own page, and the run still has it.
    expect(await runSelection("run-2")).toBe(shared.targetId);
  });
});
