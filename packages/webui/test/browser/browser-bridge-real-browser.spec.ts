// The browser bridge, against a real Chrome and a real Edge with the real
// extension.
//
// The external path has only ever been exercised against a synthetic peer. A
// synthetic peer proves the protocol; it does not prove that a browser can
// load the extension, run its service worker, hold a key in
// `chrome.storage.local` and answer a challenge with it.
//
// This spec does both halves against a real browser:
//
//   * the **happy path** — the extension loads, is provisioned, connects and
//     completes the handshake, and the host reports a connected surface;
//   * the **refusal** — the same extension without the installation key is
//     refused, and the host reports no connected surface.
//
// The refusal is the half that matters. A test that only proves the happy
// path would pass against a bridge that hands its credential to anybody.
//
// Each case writes an acceptance record — the browser version, the operating
// system, the settings that were in force and what was observed — because a
// matrix written by hand drifts from what the suite did.

import { rm } from "node:fs/promises";

import { expect, test } from "@playwright/test";

import { beginAcceptanceSuite, observeAcceptance, restoreAcceptanceRecords } from "./acceptance-record.js";
import {
  browserVersionOf,
  bridgeSettings,
  buildExtension,
  isBrowserInstalled,
  launchWithExtension,
  provision,
  startBridge,
  waitForConnected,
} from "./real-browser-bridge.js";

/**
 * The browsers the extension is exercised against.
 *
 * Edge and Chrome are both installed on this machine, and the extension is one
 * package for both, so the acceptance runs against each. Each browser is
 * admitted on **its own** surface: an Edge-hosted extension proved on the
 * Chrome surface would say nothing about the Edge switch, the Edge credential
 * or the Edge routing.
 */
const BROWSERS = [
  { channel: "chromium", surface: "chrome" },
  { channel: "msedge", surface: "edge" },
] as const;

/** The record file this suite writes. */
const SUITE = "real-browser";

test.describe("the browser bridge, against a real browser", () => {
  test.beforeAll(async () => {
    // The record is emptied here, at the start of the run: a run that failed
    // during setup would otherwise leave the previous run's cases in place.
    beginAcceptanceSuite(SUITE);
    await buildExtension();
  });

  for (const { channel, surface } of BROWSERS) {
    test(`the extension completes the handshake on the ${surface} surface in ${channel} once it can prove the installation key`, async () => {
      test.setTimeout(180_000);
      // The installed Edge is not on every machine. A case that cannot run
      // says so instead of failing on a browser that was never there.
      test.skip(
        !(await isBrowserInstalled(channel)),
        `the ${channel} browser is not installed on this machine`,
      );
      const { context, worker, extensionId, profileDir } = await launchWithExtension(channel);
      const started = await startBridge(extensionId, surface);
      const browserVersion = browserVersionOf(context);
      try {
        // The key belongs to the surface the browser is being admitted on.
        const view = await started.bridge.readInstallationKey(surface);
        expect(view).toBeDefined();

        await observeAcceptance(
          SUITE,
          {
            surface,
            browser: channel,
            browserVersion,
            entry: "development",
            case: "the extension completes the handshake once it can prove the installation key",
            settings: () => ({
              ...bridgeSettings(started.bridge, surface, "development"),
              build: "development",
              extensionId,
              installationKeyProved: true,
            }),
            observed: "the handshake completed and the host reported the surface connected",
          },
          async () => {
            await provision(worker, context, extensionId, started.origin, view!.key);
            await waitForConnected(started.bridge, surface, true, worker);

            // The host is the authority: it is the host that decides a surface
            // is connected, not the extension's own belief that it connected.
            // The **matching** surface: an Edge-hosted extension has to be
            // admitted on the Edge surface, which is a separate switch, a
            // separate credential and a separate allowlist.
            expect(started.bridge.snapshot().surfaces[surface].connected).toBe(true);
            expect(started.bridge.snapshot().surfaces[surface].enabled).toBe(true);
          },
        );
      } finally {
        await started.close();
        await context.close();
        await rm(profileDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      }
    });

    test(`an extension that cannot prove the installation key is refused on the ${surface} surface in ${channel}`, async () => {
      test.setTimeout(180_000);
      // The installed Edge is not on every machine. A case that cannot run
      // says so instead of failing on a browser that was never there.
      test.skip(
        !(await isBrowserInstalled(channel)),
        `the ${channel} browser is not installed on this machine`,
      );
      const { context, worker, extensionId, profileDir } = await launchWithExtension(channel);
      const started = await startBridge(extensionId, surface);
      const browserVersion = browserVersionOf(context);
      try {
        await observeAcceptance(
          SUITE,
          {
            surface,
            browser: channel,
            browserVersion,
            entry: "development",
            case: "an extension that cannot prove the installation key is refused",
            settings: () => ({
              ...bridgeSettings(started.bridge, surface, "development"),
              build: "development",
              extensionId,
              installationKeyProved: false,
            }),
            observed: "the host refused the extension and reported no connected surface",
          },
          async () => {
            // The same extension, connected to the same host, but with no key.
            await provision(worker, context, extensionId, started.origin, undefined);
            await waitForConnected(started.bridge, surface, false, worker);

            // It must not have been admitted, and the host must not have handed
            // it a credential.
            expect(started.bridge.snapshot().surfaces[surface].connected).toBe(false);
          },
        );
      } finally {
        await started.close();
        await context.close();
        await rm(profileDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      }
    });
  }

  test("each browser lands on its own surface when one identity is listed on both", async () => {
    // The configuration a person ends up in for real: an unpacked build has
    // one identity, and loading it in Edge and Chrome lists that identity on
    // both surfaces. The identity alone cannot say which browser is
    // connecting, so the peer names the browser it runs in and the host
    // answers with that surface's pairing.
    //
    // Taking the first match instead would put the Chrome browser on the Edge
    // pairing: the Edge surface would report connected while the person is
    // looking at Chrome, and the Chrome surface would never come up at all.
    test.setTimeout(240_000);
    // This case needs both browsers, not one: it loads the same unpacked build
    // in Edge and Chrome and checks that each lands on its own surface. A
    // machine without Edge cannot run it at all, and the convention the two
    // single-browser cases above follow — a case that cannot run says so
    // instead of failing on a browser that was never there — applies to it
    // as much as to them.
    const installed = await Promise.all(
      BROWSERS.map(({ channel }) => isBrowserInstalled(channel)),
    );
    test.skip(
      !installed.every(Boolean),
      `the ${BROWSERS.map(({ channel }) => channel).join(" and ")} browsers are not all installed on this machine`,
    );
    const browsers: {
      channel: "chromium" | "msedge";
      surface: "edge" | "chrome";
      context: Awaited<ReturnType<typeof launchWithExtension>>["context"];
      worker: Awaited<ReturnType<typeof launchWithExtension>>["worker"];
      extensionId: string;
      profileDir: string;
      browserVersion: string;
    }[] = [];
    // The first browser tells the host which identity to admit on both
    // surfaces; the second one has to arrive with the same identity, because
    // both load the one unpacked build.
    const first = await launchWithExtension(BROWSERS[0].channel);
    browsers.push({
      channel: BROWSERS[0].channel,
      surface: BROWSERS[0].surface,
      ...first,
      browserVersion: browserVersionOf(first.context),
    });
    const started = await startBridge(first.extensionId, "edge", { allowlist: "both" });
    try {
      for (const { channel, surface } of BROWSERS.slice(1)) {
        const launched = await launchWithExtension(channel);
        browsers.push({
          channel,
          surface,
          ...launched,
          browserVersion: browserVersionOf(launched.context),
        });
        const view = await started.bridge.readInstallationKey(surface);
        await provision(
          launched.worker,
          launched.context,
          launched.extensionId,
          started.origin,
          view!.key,
        );
        await waitForConnected(started.bridge, surface, true, launched.worker);
      }
      // The first browser has to be provisioned too.
      {
        const [launched] = browsers;
        const view = await started.bridge.readInstallationKey(launched!.surface);
        await provision(
          launched!.worker,
          launched!.context,
          launched!.extensionId,
          started.origin,
          view!.key,
        );
        await waitForConnected(started.bridge, launched!.surface, true, launched!.worker);
      }

      // The two unpacked builds have one identity between them, and the two
      // browsers have one host between them.
      expect(browsers[0]!.extensionId).toBe(browsers[1]!.extensionId);

      await observeAcceptance(
        SUITE,
        {
          surface: "edge and chrome",
          browser: `${browsers[0]!.channel} and ${browsers[1]!.channel}`,
          browserVersion: `${browsers[0]!.browserVersion} and ${browsers[1]!.browserVersion}`,
          entry: "development",
          case: "each browser lands on its own surface when one identity is listed on both",
          settings: () => ({
            ...bridgeSettings(started.bridge, "edge", "development, on both surfaces"),
            build: "development",
            extensionId: browsers[0]!.extensionId,
            installationKeyProved: true,
          }),
          observed:
            "both browsers were connected, each on its own surface, and each surface's provider belonged to that surface",
        },
        async () => {
          // Both surfaces are connected, each by its own browser.
          expect(started.bridge.snapshot().surfaces.edge.connected).toBe(true);
          expect(started.bridge.snapshot().surfaces.chrome.connected).toBe(true);
          // And neither browser was put on the other's surface.
          expect(started.bridge.createProvider("edge")?.surface).toBe("edge");
          expect(started.bridge.createProvider("chrome")?.surface).toBe("chrome");
        },
      );
    } finally {
      await started.close();
      for (const browser of browsers) {
        await browser.context.close();
        await rm(browser.profileDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      }
    }
  });

  // On CI the record file is tracked and the run's own timestamps are not a
  // source change, so the file goes back the way the checkout had it.
  test.afterAll(() => {
    restoreAcceptanceRecords();
  });
});
