// The Agent's browser tools, driven by Browser Core, against a real browser.
//
// Before Browser Core was adopted, the isolated Chromium answered a restricted
// browser-tool action by translating it into a raw DevTools method. That
// covered the actions that are one DevTools call wide and could not cover the
// rest: `click` and `type` take an opaque element reference, and turning one
// into a coordinate needs the element map, the retained snapshot and the
// generation check that only Browser Core has. Those actions were refused
// with `browser_capability_denied`.
//
// This suite proves the opposite, against a real page: the Agent inspects the
// page, gets a reference back, and acts on that reference. That is the whole
// point of the alignment — the same Browser Core the TUI drives, over the same
// DevTools connection this process already held.
//
// The cases below are the ones that could only pass with the semantic layer:
//
//   * `inspect` returns a reference the Agent can act on, and the reference is
//     the opaque form Browser Core issues rather than a CSS selector or a
//     coordinate;
//   * `click` on that reference reaches the element and changes the page;
//   * `type` on the same reference types into the field;
//   * a reference recorded before a navigation is refused afterwards, because
//     the navigation moved the page the reference belonged to;
//   * a reference from a page that is still current is still accepted.
//
// The last two are the fence. An element reference that survives a navigation
// is a reference into a document that is no longer there, and acting on it
// would click something the Agent never looked at.
//
// The browser is optional: a machine without Chrome skips the suite rather
// than failing it, because "the browser is missing" is not a defect in the
// provider. The repository's `test:webui-browser` gate is the one that
// requires a browser.

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { WebuiBrowserService } from "../../src/runtime/browser/browser-service.js";
import { createWebuiBrowserToolAdapter } from "../../src/runtime/browser/tool-adapter.js";
import type { WebuiBrowserAuthorization } from "../../src/shared/contracts/browser.js";

/**
 * The budget every case in this file is given.
 *
 * Every case drives a real browser, so the budget is room for a runner that
 * is several times slower than the machine the numbers were measured on. What
 * is correct and what is not is decided by `WAIT_MS`: a case whose page never
 * reaches the state it asserts fails at that deadline, with the state it was
 * waiting for named.
 */
const BROWSER_CASE_BUDGET_MS = 60_000;

/** How often a page is asked whether it has reached the state a case waits for. */
const POLL_MS = 50;

/**
 * How long a page is given to reach the state a case waits for.
 *
 * A wait is a condition rather than a pause: a page that never gets there
 * fails the case here, with the state it was waiting for named.
 */
const WAIT_MS = 5_000;

/**
 * Waits for a condition to hold.
 *
 * A condition that throws is the page's own state rather than the flow's
 * failure, so it is asked again until the deadline.
 */
async function waitFor(
  condition: () => Promise<boolean>,
  description: string,
): Promise<void> {
  const deadline = Date.now() + WAIT_MS;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      if (await condition()) return;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
  throw new Error(
    `The page never reached the state this case waits for: ${description}` +
      (lastError ? ` (last error: ${String(lastError)})` : ""),
  );
}

/** A page with a button and a field, so a click and a typing can be told apart. */
function pageHtml(): string {
  return [
    "<!doctype html><title>agent driven</title>",
    "<button id='go' onclick=\"document.title = 'clicked'\">go</button>",
    "<input id='field' type='text'>",
    "<script>",
    "document.getElementById('field').addEventListener('input', (event) => {",
    "  document.title = 'typed:' + event.target.value;",
    "});",
    "</script>",
  ].join("\n");
}

/** The data URL of the page the cases drive. */
function pageUrl(): string {
  return `data:text/html,${encodeURIComponent(pageHtml())}`;
}

/** The authorization the service needs to start the isolated Chromium. */
const AUTHORIZATION: WebuiBrowserAuthorization = {
  isolatedChromium: true,
  edge: false,
  chrome: false,
  fullCdp: false,
};

/** The shape the `inspect` answer has: the elements it found. */
interface InspectAnswer {
  readonly elements?: readonly { readonly ref?: string; readonly tag?: string }[];
}

describe("the Agent's browser tools over Browser Core", () => {
  let dataDir: string | undefined;
  let service: WebuiBrowserService | undefined;
  /**
   * The tool adapter the cases drive.
   *
   * It is the runtime's own adapter: the Agent's browser tools call
   * `LocalBrowserAdapter.execute`, and this is the object that answers. The
   * cases share one run, because a run owns its selection — a second run
   * would open a page of its own.
   */
  let tools: {
    execute: (action: string, input: Record<string, unknown>) => Promise<unknown>;
  };

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "webui-browser-core-"));
    service = new WebuiBrowserService({
      authorization: { read: async () => AUTHORIZATION, write: async () => AUTHORIZATION },
      dataDir,
    });
    await service.initialize();
  }, 60_000);

  afterAll(async () => {
    await service?.close();
    if (dataDir) await rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  /**
   * The title the page the run has selected is showing.
   *
   * It is read with `query`, which is a restricted browser-tool action, so
   * the reading goes through the same Browser Core the cases act through —
   * and the case needs no Full CDP access to observe the page.
   */
  async function readSelectionTitle(): Promise<string> {
    const answer = (await tools.execute("query", { kind: "text", selector: "body" })) as {
      title?: string;
    };
    return answer.title ?? "";
  }

  /**
   * Inspects the page and returns the elements it found.
   *
   * The inspection is asked again when the page moved while it was being
   * scanned. That refusal is the core's own and it is the right one: a scan
   * that raced a navigation describes a document that is no longer on the
   * screen, and the references it produced would be stale. The Agent is told
   * to inspect again, and so is this helper — the retry is the behaviour the
   * refusal asks for, not a way around it.
   */
  async function inspectElements(): Promise<InspectAnswer> {
    const deadline = Date.now() + WAIT_MS;
    let lastError: unknown;
    while (Date.now() < deadline) {
      try {
        return (await tools.execute("inspect", {})) as InspectAnswer;
      } catch (error) {
        lastError = error;
        const message = error instanceof Error ? error.message : String(error);
        if (!message.includes("STALE_SNAPSHOT") && !message.includes("STALE_ELEMENT_REF")) {
          throw error;
        }
        await new Promise((resolve) => setTimeout(resolve, POLL_MS));
      }
    }
    throw new Error(
      "The page never settled long enough to be inspected" +
        (lastError ? ` (last error: ${String(lastError)})` : ""),
    );
  }

  /**
   * Opens a page for the run and returns the tool adapter that drives it.
   *
   * The adapter is the runtime's own: the Agent's browser tools call
   * `LocalBrowserAdapter.execute`, and this is the object that answers.
   */
  async function openRunPage(): Promise<void> {
    const adapter = createWebuiBrowserToolAdapter({ browser: service! });
    const context = { sessionId: "run-core" } as never;
    await adapter.execute(context, "open_tab", { url: pageUrl() });
    tools = {
      execute: (action, input) => adapter.execute(context, action as never, input),
    };
  }

  it("inspects the page and gets a reference it can act on", { timeout: BROWSER_CASE_BUDGET_MS }, async () => {
    await openRunPage();

    const answer = await inspectElements();
    const elements = answer.elements ?? [];
    expect(elements.length).toBeGreaterThan(0);

    // The reference is the opaque form Browser Core issues. A CSS selector or
    // a coordinate would be a different thing: the reference is what carries
    // the snapshot it belongs to, and it is what makes a stale reference
    // detectable.
    const button = elements.find((element) => element.tag === "button");
    expect(button?.ref).toEqual(expect.stringMatching(/^browser-element:/u));
  });

  it("clicks the element the inspection named", { timeout: BROWSER_CASE_BUDGET_MS }, async () => {
    await openRunPage();
    const answer = await inspectElements();
    const button = (answer.elements ?? []).find((element) => element.tag === "button");
    expect(button?.ref).toEqual(expect.any(String));

    // The click is aimed at the reference, not at a coordinate and not at a
    // selector. This is the action the provider used to refuse.
    await tools.execute("click", { ref: button?.ref });

    await waitFor(
      async () => (await readSelectionTitle()) === "clicked",
      "the click to reach the button",
    );
  });

  it("types into the field the inspection named", { timeout: BROWSER_CASE_BUDGET_MS }, async () => {
    await openRunPage();
    const answer = await inspectElements();
    const field = (answer.elements ?? []).find((element) => element.tag === "input");
    expect(field?.ref).toEqual(expect.any(String));

    await tools.execute("type", { ref: field?.ref, text: "hello" });

    await waitFor(
      async () => (await readSelectionTitle()) === "typed:hello",
      "the typing to reach the field",
    );
  });

  it("refuses a reference recorded before the page navigated", { timeout: BROWSER_CASE_BUDGET_MS }, async () => {
    await openRunPage();
    const answer = await inspectElements();
    const button = (answer.elements ?? []).find((element) => element.tag === "button");
    expect(button?.ref).toEqual(expect.any(String));

    // The page navigates, so the document the reference belonged to is gone.
    await tools.execute("navigate", { url: pageUrl() });
    await waitFor(
      async () => (await readSelectionTitle()) === "agent driven",
      "the navigated page to load",
    );

    // The reference is refused rather than acted on. Clicking it would reach
    // an element of a document that is no longer on the screen — or worse, an
    // element of the new document that happens to sit where the old one did.
    await expect(tools.execute("click", { ref: button?.ref })).rejects.toThrow(
      /STALE_ELEMENT_REF|STALE_SNAPSHOT/u,
    );
  });

  it("accepts a reference that is still current", { timeout: BROWSER_CASE_BUDGET_MS }, async () => {
    await openRunPage();
    const answer = await inspectElements();
    const button = (answer.elements ?? []).find((element) => element.tag === "button");
    expect(button?.ref).toEqual(expect.any(String));

    // The same shape of call as the stale case above, on a page that has not
    // moved. The fence must refuse the stale reference and this one.
    await tools.execute("click", { ref: button?.ref });
    await waitFor(
      async () => (await readSelectionTitle()) === "clicked",
      "the click to reach the button",
    );
  });
});
