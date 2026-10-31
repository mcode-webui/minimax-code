// The external bridge's behaviour, against a real browser and a real page.
//
// The handshake acceptance proves that an extension can pair and that an
// unprovisioned one is refused. It does not prove that the *bridge* works —
// that a keystroke the host sends arrives in the page the person is looking
// at, that the page's image reaches the host, and that a DevTools command
// runs against the live tab.
//
// This suite closes that gap. It drives a real browser with the built
// extension, a real page, and the real bridge: the host sends, and the page
// receives.
//
// The page is read back **through the bridge**, with a DevTools command. That
// is deliberate — it means the assertion about the page comes from the same
// path a caller would use, so a broken DevTools path cannot make a broken
// input path look right.

import { rm } from "node:fs/promises";

import { expect, test } from "@playwright/test";

/**
 * The slice of the extension API this spec uses.
 *
 * The callbacks are serialized and run inside the extension's service worker,
 * where `chrome` exists; the WebUI's test tsconfig does not carry the
 * extension's ambient types.
 */
declare const chrome: {
  storage: {
    session: {
      get(key: string): Promise<Record<string, unknown>>;
    };
  };
};

/**
 * The extension's own last failure.
 *
 * The extension parks its failures in session storage rather than logging them,
 * so this is the only place a failure inside the extension is visible from
 * outside it.
 */
async function extensionLastError(
  worker: { evaluate: (fn: () => Promise<unknown>) => Promise<unknown> },
): Promise<unknown> {
  return worker
    .evaluate(() => chrome.storage.session.get("webui.browserBridge.lastError"))
    .catch(() => undefined);
}

import type { WebuiBrowserTargetState } from "../../src/shared/contracts/browser.js";
import { beginAcceptanceSuite, observeAcceptance, restoreAcceptanceRecords } from "./acceptance-record.js";
import {
  browserVersionOf,
  bridgeSettings,
  buildExtension,
  closeBrowser,
  isBrowserInstalled,
  launchWithExtension,
  provision,
  startBridge,
  waitForConnected,
} from "./real-browser-bridge.js";

const BROWSERS = [
  { channel: "chromium", surface: "chrome" },
  { channel: "msedge", surface: "edge" },
] as const;

/** The record file this suite writes. */
const SUITE = "real-external";

test.describe("the external bridge, against a real browser and a real page", () => {
  test.beforeAll(async () => {
    // The record is emptied here, at the start of the run: a run that failed
    // during setup would otherwise leave the previous run's cases in place.
    beginAcceptanceSuite(SUITE);
    await buildExtension();
  });

  for (const { channel, surface } of BROWSERS) {
    test(`the bridge survives the worker being terminated in ${channel}`, async () => {
      test.setTimeout(120_000);
      // The installed Edge is not on every machine. A case that cannot run
      // says so instead of failing on a browser that was never there.
      test.skip(
        !(await isBrowserInstalled(channel)),
        `the ${channel} browser is not installed on this machine`,
      );
      const { context, worker, extensionId, profileDir } = await launchWithExtension(channel);
      const started = await startBridge(extensionId, surface);
      // The page has to exist before the extension pairs: the extension
      // announces the tabs it can see, and there is nothing to announce in a
      // browser with no tabs.
      const page = await context.newPage();
      await page.goto(started.pageUrl);
      const browserVersion = browserVersionOf(context);
      try {
        await observeAcceptance(
          SUITE,
          {
            surface,
            browser: channel,
            browserVersion,
            entry: "development",
            case: "the bridge survives the worker being terminated during an active stream",
            settings: () => ({
              ...bridgeSettings(started.bridge, surface, "development"),
              build: "development",
              extensionId,
              installationKeyProved: true,
            }),
            observed:
              "the host noticed the terminated worker, the surface went down and came back, and a command against the live tab answered again",
          },
          async () => {
            const view = await started.bridge.readInstallationKey(surface);
            await provision(worker, context, extensionId, started.origin, view!.key);
            await waitForConnected(started.bridge, surface, true, worker);

            const provider = started.bridge.createProvider(surface);
            const target = await waitForTarget(provider!);

            // An **active** image stream, so the worker is doing work when it dies.
            const frames: unknown[] = [];
            await provider!.startImageStream(target.id.targetId, (frame) => {
              frames.push(frame);
            });
            await expect
              .poll(() => frames.length, { timeout: 20_000 })
              .toBeGreaterThan(0);

            // Terminate the service worker the way the browser does when it
            // reclaims an idle worker: closing its target ends the worker, and
            // the socket it held goes with it. The session has to notice.
            const cdp = await context.browser()!.newBrowserCDPSession();
            const { targetInfos } = (await cdp.send("Target.getTargets")) as {
              readonly targetInfos: readonly { readonly targetId: string; readonly type: string }[];
            };
            const serviceWorker = targetInfos.find((target) => target.type === "service_worker");
            expect(serviceWorker, "the extension's service worker target").toBeDefined();
            await cdp.send("Target.closeTarget", { targetId: serviceWorker!.targetId });
            await waitForConnected(started.bridge, surface, false);

            // Wake the worker. Chrome starts a terminated Manifest V3 worker on
            // the next event, and a navigation is one the extension listens for.
            await page.goto(`${started.pageUrl}?after=termination`);
            await waitForConnected(started.bridge, surface, true);

            // And the bridge works again: a command against the live tab answers.
            const title = await evaluate(provider!, target, "document.title");
            expect(typeof title).toBe("string");
          },
        );
      } finally {
        // The browser stops first. The extension reconnects to a host that is
        // going away, and a server that waits for a client to go away first
        // cannot close while that client is still running.
        await closeBrowser(context);
        await started.close();
        await rm(profileDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      }
    });

    test(`text input reaches the page through the ${surface} bridge in ${channel}`, async () => {
      test.setTimeout(120_000);
      // The installed Edge is not on every machine. A case that cannot run
      // says so instead of failing on a browser that was never there.
      test.skip(
        !(await isBrowserInstalled(channel)),
        `the ${channel} browser is not installed on this machine`,
      );
      const { context, worker, extensionId, profileDir } = await launchWithExtension(channel);
      // The page the person is looking at. It is opened *before* the
      // extension pairs, so the extension announces a real tab.
      const started = await startBridge(extensionId, surface);
      // The page is a real http page, because the extension leaves
      // policy-blocked URLs — `data:` among them — out of its targets.
      const page = await context.newPage();
      await page.goto(started.pageUrl);
      const browserVersion = browserVersionOf(context);
      try {
        await observeAcceptance(
          SUITE,
          {
            surface,
            browser: channel,
            browserVersion,
            entry: "development",
            case: "text input reaches the page and the page's image reaches the host",
            settings: () => ({
              ...bridgeSettings(started.bridge, surface, "development"),
              build: "development",
              extensionId,
              installationKeyProved: true,
            }),
            observed:
              "the text the host sent appeared in the page's field, and a non-empty image frame for that page arrived at the host",
          },
          async () => {
            const view = await started.bridge.readInstallationKey(surface);
            expect(view).toBeDefined();
            await provision(worker, context, extensionId, started.origin, view!.key);
            await waitForConnected(started.bridge, surface, true, worker);

            const provider = started.bridge.createProvider(surface);
            expect(provider).toBeDefined();

            // The extension announces the tab; the provider is how the host sees
            // it.
            const target = await waitForTarget(provider!);
            expect(target.id.surface).toBe(surface);

            await provider!.sendInput({
              kind: "text",
              target: target.id,
              text: "hello",
            }).catch(async (error: unknown) => {
              throw new Error(
                `the input did not arrive: ${String(error)} extension=${JSON.stringify(
                  await extensionLastError(worker),
                )}`,
              );
            });

            // The page is read back through Playwright, which sees the same page
            // the extension drove. Reading it through the bridge instead would
            // make this assertion depend on the DevTools path, and a broken
            // DevTools path would make a broken input path look right.
            await expect
              .poll(async () => page.inputValue("#field"), { timeout: 15_000 })
              .toBe("hello");

            // The image path: the extension captures the person's visible tab
            // and the host receives it. The frame names its own target, so the
            // host can tell whose page it is.
            const frames: { readonly targetId: string; readonly data: string }[] = [];
            await provider!.startImageStream(target.id.targetId, (frame) => {
              frames.push({ targetId: frame.target.targetId, data: frame.data });
            });
            const frameDeadline = Date.now() + 15_000;
            while (frames.length === 0 && Date.now() < frameDeadline) {
              await new Promise((resolve) => setTimeout(resolve, 200));
            }
            if (frames.length === 0) {
              throw new Error(
                `no image frame arrived: extension=${JSON.stringify(
                  await extensionLastError(worker),
                )}`,
              );
            }
            expect(frames[0]?.targetId).toBe(target.id.targetId);
            // A real image, not an empty payload.
            expect((frames[0]?.data ?? "").length).toBeGreaterThan(100);
          },
        );
      } finally {
        // The browser stops first. The extension reconnects to a host that is
        // going away, and a server that waits for a client to go away first
        // cannot close while that client is still running.
        await closeBrowser(context);
        await started.close();
        await page.close().catch(() => undefined);
        await rm(profileDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      }
    });

    test(`a DevTools command runs against the live tab through the ${surface} bridge in ${channel}`, async () => {
      test.setTimeout(120_000);
      // The installed Edge is not on every machine. A case that cannot run
      // says so instead of failing on a browser that was never there.
      test.skip(
        !(await isBrowserInstalled(channel)),
        `the ${channel} browser is not installed on this machine`,
      );
      const { context, worker, extensionId, profileDir } = await launchWithExtension(channel);
      const started = await startBridge(extensionId, surface);
      const page = await context.newPage();
      await page.goto(started.pageUrl);
      const browserVersion = browserVersionOf(context);
      try {
        await observeAcceptance(
          SUITE,
          {
            surface,
            browser: channel,
            browserVersion,
            entry: "development",
            case: "a DevTools command runs against the live tab, and one outside the allowed set is refused as unsupported",
            settings: () => ({
              ...bridgeSettings(started.bridge, surface, "development"),
              build: "development",
              extensionId,
              installationKeyProved: true,
            }),
            observed:
              "the command in the allowed subset answered with the page's title, and a command outside it was refused as unsupported",
          },
          async () => {
            const view = await started.bridge.readInstallationKey(surface);
            await provision(worker, context, extensionId, started.origin, view!.key);
            await waitForConnected(started.bridge, surface, true, worker);

            const provider = started.bridge.createProvider(surface);
            const target = await waitForTarget(provider!);

            // A command in the extension's supported subset, against a live tab.
            const title = await evaluate(provider!, target, "document.title");
            expect(title).toBe("idle");

            // A command outside the subset is refused with a reason, and the
            // refusal says *unsupported* rather than failing generically.
            await expect(
              provider!.sendCommand(target.id, "Browser.setPermission", { permission: { name: "geolocation" } }),
            ).rejects.toMatchObject({ code: "browser_capability_denied" });
          },
        );
      } finally {
        // The browser stops first. The extension reconnects to a host that is
        // going away, and a server that waits for a client to go away first
        // cannot close while that client is still running.
        await closeBrowser(context);
        await started.close();
        await page.close().catch(() => undefined);
        await rm(profileDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      }
    });
  }

  // On CI the record file is tracked and the run's own timestamps are not a
  // source change, so the file goes back the way the checkout had it.
  test.afterAll(() => {
    restoreAcceptanceRecords();
  });
});

/** Waits for the extension to announce a tab. */
async function waitForTarget(
  provider: { listTargets(): Promise<readonly WebuiBrowserTargetState[]> },
): Promise<WebuiBrowserTargetState> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const targets = await provider.listTargets();
    const target = targets.find((entry) => entry.id.targetId !== "");
    if (target) return target;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("the extension announced no target");
}

/**
 * Evaluates an expression against the live tab, through the bridge.
 *
 * The value is read back from the DevTools result rather than from the page's
 * own API, so the assertion is about what the browser actually holds.
 */
async function evaluate(
  provider: {
    sendCommand(
      target: { readonly targetId: string; readonly generation: number },
      command: string,
      params: Record<string, unknown>,
    ): Promise<unknown>;
  },
  target: WebuiBrowserTargetState,
  expression: string,
): Promise<unknown> {
  const result = (await provider.sendCommand(target.id, "Runtime.evaluate", {
    expression,
    returnByValue: true,
  })) as { readonly result?: { readonly value?: unknown } } | undefined;
  return result?.result?.value;
}
