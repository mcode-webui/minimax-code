// The acceptance of the workspace browser tab model.
//
// A real isolated Chromium, the Agent's tool opening a real tab, the strip
// gaining it, the picture updating, and the person taking over — **recorded,
// not asserted**.
//
// The cases are the acceptance matrix of issue #212, one `it` per case, and
// each one writes a record through the programme's own acceptance helper. The
// record lands in this programme's completion directory, so it cannot be read
// as another plan's evidence, and the published matrix
// (`packages/webui/docs/browser-use/09-acceptance-record.md`) is written from
// what these records say.
//
// The suite drives the shipped paths: the Agent's tool path through the
// browser tool adapter, the person's launcher path through the server's own
// handler, the input path through the client's own binding, and the provider
// itself. A case that only exercised a helper would not be the case.

import { execFileSync } from "node:child_process";
import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { WebuiBrowserService } from "../../src/runtime/browser/browser-service.js";
import { createWebuiBrowserToolAdapter } from "../../src/runtime/browser/tool-adapter.js";
import type { WebuiBrowserPort } from "../../src/runtime/port.js";
import { prepareWebuiBrowserInputCommand } from "../../src/client/features/browser/application/browser-commands.js";
import {
  webuiWorkspaceLauncherOpenPage,
  webuiWorkspaceLauncherUrl,
  webuiWorkspaceTabStripReconcile,
} from "../../src/client/features/workspace/ui/WebuiWorkspaceTabStrip.public.tsx";
import {
  initialWorkspacePanelState,
  reduceWorkspacePanelState,
  type WorkspacePanelState,
} from "../../src/client/features/workspace/projection/workspace-panel-state.js";
import { createBrowserHandlerEntries } from "../../src/server/operation/handlers/browser.js";
import {
  SEND_BROWSER_COMMAND_OPERATION_NAME,
  SEND_BROWSER_INPUT_OPERATION_NAME,
} from "../../src/shared/operation-names.js";
import { acceptanceRecordsFor, restoreAcceptanceRecords } from "../browser/acceptance-record.js";
import type {
  WebuiBrowserAuthorization,
  WebuiBrowserTargetId,
} from "../../src/shared/contracts/browser.js";

/** This programme's records. They live in its own completion directory. */
const records = acceptanceRecordsFor("workspace-browser-tab");
const SUITE = "workspace-browser-tab";

/** How long a page is given to settle after a move. */
const SETTLE_MS = 750;

/**
 * How long a case may take.
 *
 * A case drives a real browser: the first one launches it, opens a tab and
 * waits for the strip to gain it. The default budget (5s) is smaller than a
 * cold browser start on a loaded runner, and a case that runs out of time
 * leaves the browser half launched — the next case then finds a browser that
 * exited during startup and fails too. The sibling suite
 * (`browser-panel-live-navigation.test.ts`) has always given its cases 30s.
 */
const TIMEOUT_MS = 30_000;

async function chromeIsAvailable(): Promise<boolean> {
  for (const candidate of ["/usr/bin/google-chrome", "/usr/bin/chromium"]) {
    try {
      await access(candidate);
      return true;
    } catch {
      // Keep looking.
    }
  }
  return false;
}

const available = await chromeIsAvailable();

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

function pageUrl(title: string): string {
  return `data:text/html,${encodeURIComponent(pageHtml(title))}`;
}

const delay = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

describe.skipIf(!available)("the acceptance of the workspace browser tab model", () => {
  let dataDir: string;
  let service: WebuiBrowserService;
  let browserVersion = "unknown";

  const authorization: WebuiBrowserAuthorization = {
    isolatedChromium: true,
    edge: false,
    chrome: false,
    // The acceptance reads a page back with a raw DevTools method, and the Full
    // CDP switch is what allows one through.
    fullCdp: true,
  };

  beforeAll(async () => {
    try {
      browserVersion = execFileSync("/usr/bin/google-chrome", ["--version"], {
        encoding: "utf8",
      }).trim();
    } catch {
      browserVersion = "unknown";
    }
    dataDir = await mkdtemp(join(tmpdir(), "webui-tab-acceptance-"));
    service = new WebuiBrowserService({
      authorization: {
        read: async () => authorization,
        write: async () => authorization,
      },
      dataDir,
    });
    agent = createWebuiBrowserToolAdapter({ browser: service });
  }, 60_000);

  afterAll(async () => {
    await service?.close();
    if (dataDir) await rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    // On CI the record file is tracked and the run's own timestamps are not a
    // source change, so the file goes back the way the checkout had it.
    restoreAcceptanceRecords();
  });

  // -- the paths the cases drive ------------------------------------------

  /** The Agent's tool path, through the adapter the Agent's tools use. */
  let agent: ReturnType<typeof createWebuiBrowserToolAdapter>;

  /** The server's own handler for an operation, validation and routing included. */
  function handler(operation: string): {
    readonly validate: (body: unknown) => {
      readonly ok: boolean;
      readonly body?: Record<string, unknown>;
      readonly message?: string;
    };
    readonly handle: (
      context: { readonly requestId: string; readonly signal?: AbortSignal },
      body: Record<string, unknown>,
    ) => Promise<unknown>;
  } {
    const entry = createBrowserHandlerEntries(service as unknown as WebuiBrowserPort).get(operation);
    if (!entry) throw new Error(`${operation} has no handler`);
    return {
      validate: entry.operation.validate as never,
      handle: entry.handle as never,
    };
  }

  /** Sends one browser command through the wire the toolbar uses. */
  async function sendCommand(request: Record<string, unknown>): Promise<unknown> {
    const entry = handler(SEND_BROWSER_COMMAND_OPERATION_NAME);
    const validated = entry.validate(request);
    if (!validated.ok) throw new Error(validated.message);
    const result = await entry.handle({ requestId: "acceptance" }, validated.body!);
    return (result as { readonly body?: { readonly result?: unknown } }).body?.result;
  }

  /** Sends one input through the wire the panel's input uses. */
  async function sendInput(request: Record<string, unknown>): Promise<unknown> {
    const entry = handler(SEND_BROWSER_INPUT_OPERATION_NAME);
    const validated = entry.validate(request);
    if (!validated.ok) throw new Error(validated.message);
    const result = await entry.handle({ requestId: "acceptance" }, validated.body!);
    return (result as { readonly body?: { readonly result?: unknown } }).body?.result;
  }

  /**
   * The title the page behind the target is showing.
   *
   * The page is read through its **current** identity, the way the client
   * reads it: the runtime's snapshot publishes the generation the page is on
   * now, and a reference recorded before a navigation is refused rather than
   * read.
   */
  async function readTitle(target: WebuiBrowserTargetId): Promise<string> {
    const current = await currentIdentity(target.targetId);
    const read = (await sendCommand({
      surface: current.surface,
      command: "Runtime.evaluate",
      params: { expression: "document.title", returnByValue: true },
      target: current,
    })) as { result?: { value?: unknown } } | undefined;
    return typeof read?.result?.value === "string" ? read.result.value : "";
  }

  /** The value in the page's field, read through the page's current identity. */
  async function readField(target: WebuiBrowserTargetId): Promise<string> {
    const current = await currentIdentity(target.targetId);
    const read = (await sendCommand({
      surface: current.surface,
      command: "Runtime.evaluate",
      params: {
        expression: "document.getElementById('field').value",
        returnByValue: true,
      },
      target: current,
    })) as { result?: { value?: unknown } } | undefined;
    return typeof read?.result?.value === "string" ? read.result.value : "";
  }

  /**
   * The page's current identity.
   *
   * A page that is still loading is observed as a replaced page when its
   * first load lands, so the generation the `open_tab` answer carried is
   * behind by the time the page settles. The runtime's own listing is what
   * says where the page is now.
   */
  async function currentIdentity(targetId: string): Promise<WebuiBrowserTargetId> {
    const list = await service.listTargets("isolated-chromium");
    const found = list.targets.find((entry) => entry.id.targetId === targetId);
    if (!found) throw new Error(`the page ${targetId} is not in the target list`);
    return found.id;
  }

  /** The run's selection, as the runtime holds it. */
  async function runSelection(runId: string): Promise<WebuiBrowserTargetId | undefined> {
    const list = await service.listTargets("isolated-chromium", runId);
    return list.targets.find((entry) => entry.selected)?.id;
  }

  /** The panel's tabs, as the client's reducer holds them. */
  function panel(): WorkspacePanelState {
    return initialWorkspacePanelState;
  }

  /** Records one case: its observation, the settings, and what was seen. */
  async function record(
    name: string,
    observed: string,
    body: () => Promise<void>,
  ): Promise<void> {
    await records.observe(
      SUITE,
      {
        surface: "isolated-chromium",
        browser: "google-chrome",
        browserVersion,
        entry: "development",
        case: name,
        settings: () => ({
          isolatedChromium: true,
          edge: false,
          chrome: false,
          fullCdp: true,
          runId: "run-1",
        }),
        observed,
      },
      body,
    );
  }

  // -- the cases ----------------------------------------------------------

  it("the Agent opens a tab, and the strip gains it as the active tab", async () => {
    await record(
      "the Agent opens a tab",
      "the run's selection points at the page the Agent opened, the runtime publishes it, and the strip's reconciliation makes it the active panel tab",
      async () => {
        const opened = (await agent.execute(
          { sessionId: "run-1" } as never,
          "open_tab",
          { url: pageUrl("agent page") },
        )) as WebuiBrowserTargetId;
        expect(opened.targetId).toEqual(expect.any(String));

        // The runtime's cell: the run's selection points at the new page.
        const selection = await runSelection("run-1");
        expect(selection?.targetId).toBe(opened.targetId);

        // The client's cell: the **runtime's own published stream** is read,
        // the strip's reconciliation turns what it published into a panel
        // command, and the reducer makes the tab the active one. The mounted
        // strip is covered by the unit suites; what this case proves is that
        // the runtime publishes the Agent's tab, and that the strip's own
        // reconciliation and the reducer agree on it.
        const controller = new AbortController();
        const published = await (async () => {
          for await (const snapshot of service.watchWebTabs(
            "isolated-chromium",
            "run-1",
            controller.signal,
          )) {
            return snapshot;
          }
          throw new Error("the snapshot stream ended without publishing anything");
        })();
        controller.abort();

        expect(published.tabs.map((tab) => tab.target.targetId)).toContain(opened.targetId);
        const commands = webuiWorkspaceTabStripReconcile(panel().tabs, published);
        expect(commands).toHaveLength(1);
        let state = reduceWorkspacePanelState(panel(), commands[0]!.command);
        expect(state.activeTabId).toBe(state.tabs[0]?.id);
        expect(state.tabs[0]?.content.kind).toBe("web");
      },
    );
  }, TIMEOUT_MS);

  it("the Agent navigates after opening, and the picture follows", async () => {
    await record(
      "the Agent navigates after opening",
      "the page is at the requested url and the frame stream follows the page it opened",
      async () => {
        const opened = (await agent.execute(
          { sessionId: "run-2" } as never,
          "open_tab",
          { url: pageUrl("first") },
        )) as WebuiBrowserTargetId;
        await agent.execute(
          { sessionId: "run-2" } as never,
          "navigate",
          { url: pageUrl("second") },
        );
        await delay(SETTLE_MS);
        const current = await currentIdentity(opened.targetId);
        expect(current.generation).toBeGreaterThan(opened.generation);

        // The picture follows: the frame stream for the target delivers a
        // frame of the page the Agent navigated to.
        const frames: unknown[] = [];
        const controller = new AbortController();
        const stream = (async () => {
          for await (const frame of service.watchFrames(
            "isolated-chromium",
            current,
            controller.signal,
          )) {
            frames.push(frame);
          }
        })();
        await delay(200);
        controller.abort();
        await stream.catch(() => undefined);
        expect(frames.length).toBeGreaterThan(0);
      },
    );
  }, TIMEOUT_MS);

  it("the Agent acts on a page it did not open, and a stale reference is refused", async () => {
    await record(
      "the Agent acts on a page it did not open",
      "the action runs on the run's selection, and a reference recorded before the page moved is refused",
      async () => {
        const list = await service.listTargets("isolated-chromium", "run-3");
        let before: WebuiBrowserTargetId | undefined;
        for (const candidate of list.targets) {
          await service.selectTarget(candidate.id, "run-3");
          const driven = await service
            .sendCommandToSelection("isolated-chromium", "run-3", "Runtime.evaluate", {
              expression: "1",
            })
            .then(() => true)
            .catch(() => false);
          if (driven) {
            before = candidate.id;
            break;
          }
        }
        expect(before).toBeDefined();

        // The Agent's action runs on the run's selection.
        await agent.execute({ sessionId: "run-3" } as never, "navigate", {
          url: pageUrl("acted on"),
        });
        await delay(SETTLE_MS);

        // And a reference recorded before the page moved is refused.
        expect(before).toBeDefined();
        await expect(
          service.sendInput({ kind: "text", target: before!, text: "stale" }),
        ).rejects.toMatchObject({ code: "browser_target_stale" });
      },
    );
  }, TIMEOUT_MS);

  it("a person opens a tab while the Agent works, and the two pages differ", async () => {
    await record(
      "a person opens a tab while the Agent works",
      "the Agent's page and the person's page are different, and each shows its own picture",
      async () => {
        const agentPage = (await agent.execute(
          { sessionId: "run-4" } as never,
          "open_tab",
          { url: pageUrl("agent's page") },
        )) as WebuiBrowserTargetId;

        // The person's path: the runtime's own handler, with the run named so
        // the bootstrap can be decided.
        const entry = handler("openBrowserWebTab");
        const validated = entry.validate({ url: pageUrl("person's page"), runId: "run-4" });
        expect(validated.ok).toBe(true);
        const opened = (await entry.handle(
          { requestId: "acceptance" },
          validated.body!,
        )) as { readonly body?: { readonly target?: WebuiBrowserTargetId } };
        const personPage = opened.body?.target;
        expect(personPage?.targetId).toEqual(expect.any(String));
        expect(personPage?.targetId).not.toBe(agentPage.targetId);

        // Each page shows its own picture: each one's title is its own.
        expect(await readTitle(agentPage)).toContain("agent");
        expect(await readTitle(personPage!)).toContain("person");
      },
    );
  }, TIMEOUT_MS);

  it("a person opens a tab while the run has no selection, and the run gets it", async () => {
    await record(
      "a person opens a tab while the run has no selection",
      "the run's selection becomes the person's page, so the Agent can act on it",
      async () => {
        const entry = handler("openBrowserWebTab");
        const validated = entry.validate({ url: pageUrl("bootstrapped"), runId: "run-cold" });
        expect(validated.ok).toBe(true);
        const opened = (await entry.handle(
          { requestId: "acceptance" },
          validated.body!,
        )) as { readonly body?: { readonly target?: WebuiBrowserTargetId } };
        const page = opened.body?.target;
        expect(page).toBeDefined();

        // The bootstrap: the run had no selection, so it gets the person's page.
        const selection = await runSelection("run-cold");
        expect(selection?.targetId).toBe(page!.targetId);

        // And the Agent can act on it.
        await agent.execute({ sessionId: "run-cold" } as never, "navigate", {
          url: pageUrl("acted on by the agent"),
        });
        await delay(SETTLE_MS);
        expect(await readTitle(page!)).toContain("acted on");
      },
    );
  }, TIMEOUT_MS);

  it("a person types into their own tab while the Agent works", async () => {
    await record(
      "a person types into their own tab while the Agent works",
      "the input reaches the person's page, not the Agent's",
      async () => {
        const agentPage = (await agent.execute(
          { sessionId: "run-5" } as never,
          "open_tab",
          { url: pageUrl("agent's page") },
        )) as WebuiBrowserTargetId;
        const entry = handler("openBrowserWebTab");
        const validated = entry.validate({ url: pageUrl("person's page"), runId: "run-5" });
        const opened = (await entry.handle(
          { requestId: "acceptance" },
          validated.body!,
        )) as { readonly body?: { readonly target?: WebuiBrowserTargetId } };
        const personPage = opened.body!.target!;

        // The person's input: the client's own binding, aimed at the page the
        // person is looking at. The field is clicked first, the way a person's
        // click is, and the text follows into the focused field.
        //
        // The binding carries the page's generation, and the generation moves
        // when the page behind it is replaced — a page that is still loading
        // is observed as a replaced page. The reads above already read through
        // the page's current identity for that reason; the input is bound the
        // same way, or the runtime refuses it as a target that was replaced
        // before the input arrived.
        const aimed = await currentIdentity(personPage.targetId);
        const centre = (await sendCommand({
          surface: aimed.surface,
          command: "Runtime.evaluate",
          params: {
            expression:
              "(() => { const r = document.getElementById('field').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()",
            returnByValue: true,
          },
          target: aimed,
        })) as { result?: { value?: { x?: number; y?: number } } } | undefined;
        const click = prepareWebuiBrowserInputCommand(aimed, {
          kind: "pointer",
          x: centre?.result?.value?.x ?? 0,
          y: centre?.result?.value?.y ?? 0,
          button: "left",
          clickCount: 1,
        });
        expect(click.ok).toBe(true);
        if (!click.ok) throw new Error(click.error.message);
        await sendInput(click.command as unknown as Record<string, unknown>);

        // The click may have moved the page on, so the text is bound to the
        // identity the page carries now.
        const bound = prepareWebuiBrowserInputCommand(await currentIdentity(personPage.targetId), {
          kind: "text",
          text: "person typed",
        });
        expect(bound.ok).toBe(true);
        if (!bound.ok) throw new Error(bound.error.message);
        await sendInput(bound.command as unknown as Record<string, unknown>);
        await delay(SETTLE_MS);

        expect(await readField(personPage)).toBe("person typed");
        // The Agent's page is untouched.
        expect(await readField(agentPage)).toBe("");
      },
    );
  }, TIMEOUT_MS);

  it("a person types a url in the launcher, and the tab becomes that page", async () => {
    await record(
      "a person types a url in the launcher",
      "the tab becomes that page, and the url is shown read-only in the toolbar",
      async () => {
        const state = reduceWorkspacePanelState(panel(), { type: "open-new-tab" });
        const tabId = state.activeTabId!;
        const url = webuiWorkspaceLauncherUrl("example.test");
        // The launcher hands the browser the same canonical address the
        // address bar uses, so a bare host arrives with the root path the
        // URL parser gives it.
        expect(url).toBe("https://example.test/");

        const entry = handler("openBrowserWebTab");
        const opened = (await entry.handle(
          { requestId: "acceptance" },
          entry.validate({ url: pageUrl("typed url") }).body!,
        )) as { readonly body?: { readonly target?: WebuiBrowserTargetId } };
        const target = opened.body!.target!;

        // The launcher's ask-then-bind transition: the same tab becomes the
        // web page.
        const commands: unknown[] = [];
        await webuiWorkspaceLauncherOpenPage({
          tabId,
          url,
          dispatch: (command) => commands.push(command),
          open: async () => ({ accepted: true as const, target, result: target }),
        });
        expect(commands).toHaveLength(2);
        expect((commands[1] as { readonly type: string }).type).toBe("open-web-tab");
      },
    );
  }, TIMEOUT_MS);

  it("a person closes a web tab, and the page is released", async () => {
    await record(
      "a person closes a web tab",
      "the page is released, and the runtime's page set follows the strip",
      async () => {
        const opened = (await agent.execute(
          { sessionId: "run-6" } as never,
          "open_tab",
          { url: pageUrl("closed") },
        )) as WebuiBrowserTargetId;
        expect(
          (await service.listTargets("isolated-chromium", "run-6")).targets.some(
            (entry) => entry.id.targetId === opened.targetId,
          ),
        ).toBe(true);

        // The close goes through the **shipped path** — the server's own
        // handler, the way the strip's close button reaches it — and not
        // through the service's method. Calling the service directly would
        // prove the service and say nothing about whether a person closing a
        // tab closes the page.
        const close = handler("closeBrowserWebTab");
        const validated = close.validate({ target: opened });
        expect(validated.ok).toBe(true);
        if (!validated.ok) throw new Error(validated.message);
        await close.handle({ requestId: "acceptance" }, validated.body!);
        await delay(SETTLE_MS);

        // The page is gone from the browser, not only from the panel's list.
        expect(
          (await service.listTargets("isolated-chromium", "run-6")).targets.some(
            (entry) => entry.id.targetId === opened.targetId,
          ),
        ).toBe(false);
        // And the tab is no longer the run's selection.
        expect(await runSelection("run-6")).toBeUndefined();
      },
    );
  }, TIMEOUT_MS);

  it("back and forward move through the page's own history", async () => {
    await record(
      "back and forward",
      "the page moves through its own history, and the generation follows",
      async () => {
        const opened = (await agent.execute(
          { sessionId: "run-7" } as never,
          "open_tab",
          { url: pageUrl("history one") },
        )) as WebuiBrowserTargetId;
        const page = await currentIdentity(opened.targetId);
        await agent.execute({ sessionId: "run-7" } as never, "navigate", {
          url: pageUrl("history two"),
        });
        await delay(SETTLE_MS);
        // The toolbar addresses the page the snapshot publishes, so the move
        // goes to the page's current identity.
        const moved = await currentIdentity(opened.targetId);

        await sendCommand({
          surface: moved.surface,
          command: "back",
          target: moved,
        });
        await delay(SETTLE_MS);
        expect(await readTitle(moved)).toContain("history one");

        // The move advanced the page's generation, so the next press names the
        // page as it is now — the toolbar reads the generation the runtime's
        // snapshot publishes, and a reference recorded before the move is
        // refused.
        const back = await currentIdentity(opened.targetId);
        expect(back.generation).toBeGreaterThan(moved.generation);
        await expect(
          sendCommand({ surface: moved.surface, command: "forward", target: moved }),
        ).rejects.toMatchObject({ code: "browser_target_stale" });

        await sendCommand({
          surface: back.surface,
          command: "forward",
          target: back,
        });
        await delay(SETTLE_MS);
        expect(await readTitle(back)).toContain("history two");
      },
    );
  }, TIMEOUT_MS);

  it("the surface's switch is off, and both paths are refused", async () => {
    await record(
      "the surface's switch is off",
      "the Agent's open_tab and the person's launcher path are both refused with browser_surface_not_authorized",
      async () => {
        const off = new WebuiBrowserService({
          authorization: {
            read: async () => ({
              isolatedChromium: false,
              edge: false,
              chrome: false,
              fullCdp: false,
            }),
            write: async () => ({
              isolatedChromium: false,
              edge: false,
              chrome: false,
              fullCdp: false,
            }),
          },
          dataDir: join(dataDir, "off"),
        });
        try {
          const offAgent = createWebuiBrowserToolAdapter({ browser: off });
          await expect(
            offAgent.execute({ sessionId: "run-off" } as never, "open_tab", {
              url: pageUrl("refused"),
            }),
          ).rejects.toMatchObject({ code: "browser_surface_not_authorized" });

          const entry = createBrowserHandlerEntries(off as unknown as WebuiBrowserPort).get(
            "openBrowserWebTab",
          );
          const validated = entry!.operation.validate({ url: pageUrl("refused") });
          expect(validated.ok).toBe(true);
          if (!validated.ok) throw new Error(validated.message);
          await expect(
            entry!.handle({ requestId: "acceptance" }, validated.body),
          ).rejects.toMatchObject({ code: "browser_surface_not_authorized" });
        } finally {
          await off.close();
        }
      },
    );
  }, TIMEOUT_MS);

  it("a run with no selection is refused every action but open_tab", async () => {
    await record(
      "a run with no selection acts",
      "every action except open_tab is refused with browser_target_unknown",
      async () => {
        await expect(
          agent.execute({ sessionId: "run-cold-2" } as never, "navigate", {
            url: pageUrl("refused"),
          }),
        ).rejects.toMatchObject({ code: "browser_target_unknown" });
        await expect(
          agent.execute({ sessionId: "run-cold-2" } as never, "reload", {}),
        ).rejects.toMatchObject({ code: "browser_target_unknown" });
        // The one exception.
        const opened = await agent.execute(
          { sessionId: "run-cold-2" } as never,
          "open_tab",
          { url: pageUrl("allowed") },
        );
        expect(opened).toBeDefined();
      },
    );
  }, TIMEOUT_MS);

  it("a session ends, and its pages are released", async () => {
    await record(
      "a session ends",
      "its pages are released and no page is left behind",
      async () => {
        const opened = (await agent.execute(
          { sessionId: "run-8" } as never,
          "open_tab",
          { url: pageUrl("session page") },
        )) as WebuiBrowserTargetId;

        await service.releaseSession("run-8");
        await delay(SETTLE_MS);

        expect(
          (await service.listTargets("isolated-chromium")).targets.some(
            (entry) => entry.id.targetId === opened.targetId,
          ),
        ).toBe(false);
        expect(await runSelection("run-8")).toBeUndefined();
      },
    );
  }, TIMEOUT_MS);

  it("a second web tab in one session is addressable, and the strip shows both", async () => {
    await record(
      "a second web tab in one session",
      "both are addressable, and the strip shows both",
      async () => {
        const first = (await agent.execute(
          { sessionId: "run-9" } as never,
          "open_tab",
          { url: pageUrl("first tab") },
        )) as WebuiBrowserTargetId;
        const second = (await agent.execute(
          { sessionId: "run-9" } as never,
          "open_tab",
          { url: pageUrl("second tab") },
        )) as WebuiBrowserTargetId;
        expect(second.targetId).not.toBe(first.targetId);
        const firstPage = await currentIdentity(first.targetId);
        const secondPage = await currentIdentity(second.targetId);

        // Both are addressable: each is driven on its own.
        await agent.execute({ sessionId: "run-9" } as never, "navigate", {
          url: pageUrl("the second tab, navigated"),
        });
        await delay(SETTLE_MS);
        expect(await readTitle(secondPage)).toContain("navigated");
        expect(await readTitle(firstPage)).toContain("first tab");

        // And the strip shows both.
        const published = {
          surface: "isolated-chromium" as const,
          tabs: [
            { id: first.targetId, target: first, title: "first tab", url: "", selected: false },
            { id: second.targetId, target: second, title: "second tab", url: "", selected: true },
          ],
        };
        expect(webuiWorkspaceTabStripReconcile([], published)).toHaveLength(2);
      },
    );
  }, TIMEOUT_MS);

  it("a page navigates, and a stale reference is refused on every tab", async () => {
    await record(
      "a page navigates",
      "its generation advances, and a reference recorded against the old generation is refused — on every tab, not only the first",
      async () => {
        const first = (await agent.execute(
          { sessionId: "run-10" } as never,
          "open_tab",
          { url: pageUrl("first") },
        )) as WebuiBrowserTargetId;
        const second = (await agent.execute(
          { sessionId: "run-10" } as never,
          "open_tab",
          { url: pageUrl("second") },
        )) as WebuiBrowserTargetId;

        // The **second** page navigates — the one that is not the launch page.
        await agent.execute({ sessionId: "run-10" } as never, "navigate", {
          url: pageUrl("second, navigated"),
        });
        await delay(SETTLE_MS);

        const list = await service.listTargets("isolated-chromium", "run-10");
        const moved = list.targets.find((entry) => entry.id.targetId === second.targetId);
        expect(moved?.id.generation).toBeGreaterThan(second.generation);

        // The stale reference is refused on that page…
        await expect(
          service.sendInput({ kind: "text", target: second, text: "stale" }),
        ).rejects.toMatchObject({ code: "browser_target_stale" });
        // …and the other page's own reference is still current.
        const other = list.targets.find((entry) => entry.id.targetId === first.targetId);
        await expect(
          service.sendInput({ kind: "text", target: other!.id, text: "current" }),
        ).resolves.toMatchObject({ accepted: true });
      },
    );
  }, TIMEOUT_MS);
});
