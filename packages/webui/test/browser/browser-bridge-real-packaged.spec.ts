// The packaged production entry, against a real browser with a real store build.
//
// The other suites admit an **unpacked** extension: its id is derived from the
// directory it was loaded from, so the id is a property of the machine rather
// than of the extension. A packaged build is different — it carries the
// store's public key, and its id is the one that key determines. That is the
// id a store issues, and the id the bridge has to validate.
//
// So this suite proves, for **each** store and in **that store's browser**:
//
//   1. the id the browser assigns to the store build is exactly the id the
//      public key determines — the identity the bridge validates is the
//      identity the browser assigns;
//   2. a **packaged** host admits that build, through the store allowlist;
//   3. the same packaged host **refuses** the same extension when the id is
//      named only in the development allowlist, because a packaged host must
//      not accept a development identity.
//
// The third one is the point of the whole distinction. A packaged host that
// fell back to the development allowlist would admit whatever unpacked
// extension happened to be present, which is the identity nobody can rely on.
//
// The key is generated here rather than checked in. It is a *public* key — the
// private half never leaves this process — and a fresh one per run means the
// test cannot pass against a hard-coded id.

import { createHash, generateKeyPairSync } from "node:crypto";
import { readFile } from "node:fs/promises";
import { rm } from "node:fs/promises";
import { resolve } from "node:path";

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

/** The record file this suite writes. */
const SUITE = "real-packaged";

/** The development build's manifest, for the build comparison. */
const developmentDist = resolve(
  new URL("../../../browser-extension/dist/manifest.json", import.meta.url).pathname,
);

/**
 * The two stores.
 *
 * One extension source, two artifacts, and each artifact is checked in the
 * browser its store serves: the Chrome Web Store build in Chrome, the Edge
 * Add-ons build in Edge.
 */
const STORES = [
  { store: "chrome", channel: "chromium", surface: "chrome" },
  { store: "edge", channel: "msedge", surface: "edge" },
] as const;

/** Where a store build is built. It is not `dist/`: the two cannot share. */
function storeDistOf(store: "chrome" | "edge"): string {
  return resolve(
    new URL(`../../../browser-extension/dist-store-${store}`, import.meta.url).pathname,
  );
}

/**
 * The extension id the public key determines.
 *
 * This is the browser's own rule: the id is the first sixteen bytes of the
 * SHA-256 of the DER-encoded public key, with each nibble mapped to a letter
 * from `a`. The suite asserts the browser agrees, so the rule is checked
 * rather than assumed.
 */
function extensionIdOfPublicKey(publicKeyDer: Buffer): string {
  return createHash("sha256")
    .update(publicKeyDer)
    .digest()
    .subarray(0, 16)
    .toString("hex")
    .split("")
    .map((nibble) => String.fromCharCode("a".charCodeAt(0) + Number.parseInt(nibble, 16)))
    .join("");
}

test.describe("the packaged production entry, against a real browser", () => {
  test.setTimeout(240_000);

  test.beforeAll(() => {
    // The record is emptied here, at the start of the run: a run that failed
    // during setup would otherwise leave the previous run's cases in place.
    beginAcceptanceSuite(SUITE);
  });

  for (const { store, channel, surface } of STORES) {
    test(`the ${store} store build's identity is the one its public key determines, and only a packaged host admits it`, async () => {
      const { publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
      const publicKeyDer = publicKey.export({ type: "spki", format: "der" });
      const publicKeyBase64 = publicKeyDer.toString("base64");
      const expectedId = extensionIdOfPublicKey(publicKeyDer);

      // The development build first: it is the other half of the comparison
      // below, and it is what a developer loads.
      await buildExtension();
      await buildExtension({
        store,
        out: `dist-store-${store}`,
        publicKey: publicKeyBase64,
      });

      // The installed Edge is not on every machine. A case that cannot run
      // says so instead of failing on a browser that was never there.
      test.skip(
        !(await isBrowserInstalled(channel)),
        `the ${channel} browser is not installed on this machine`,
      );
      const { context, worker, extensionId, profileDir } = await launchWithExtension(channel, {
        dist: storeDistOf(store),
      });
      const browserVersion = browserVersionOf(context);
      try {
        await observeAcceptance(
          SUITE,
          {
            surface,
            browser: channel,
            browserVersion,
            entry: "packaged",
            case: `the ${store} store build's identity is the one its public key determines`,
            settings: () => ({
              // These two cases are about the **build**, and there is no host
              // yet: the switch states come from the host once it exists.
              surface,
              build: "store",
              allowlist: "store",
              extensionId,
              installationKeyProved: true,
            }),
            observed: `the browser assigned the extension the id the public key determines (${expectedId})`,
          },
          async () => {
            // The identity the browser assigned and the identity the key
            // determines are the same string.
            expect(extensionId).toBe(expectedId);
          },
        );

        // The packaged build differs from the development build in exactly one
        // way: the manifest carries the store's public key, and the id follows
        // from it. Nothing else about the extension is different.
        await observeAcceptance(
          SUITE,
          {
            surface,
            browser: channel,
            browserVersion,
            entry: "packaged",
            case: `the ${store} store build differs from the development build in exactly the manifest key`,
            settings: () => ({
              // These two cases are about the **build**, and there is no host
              // yet: the switch states come from the host once it exists.
              surface,
              build: "store",
              allowlist: "store",
              extensionId,
              installationKeyProved: true,
            }),
            observed: "the packaged manifest carries the store's public key and differs from the development manifest in nothing else",
          },
          async () => {
            const packaged = JSON.parse(
              await readFile(resolve(storeDistOf(store), "manifest.json"), "utf8"),
            ) as Record<string, unknown>;
            // The comparison is against the **development build**, not the
            // source manifest: the build rewrites the two source paths, and
            // that rewrite is not a difference between the two builds.
            const development = JSON.parse(
              await readFile(resolve(developmentDist), "utf8"),
            ) as Record<string, unknown>;
            expect(packaged.key).toBe(publicKeyBase64);
            expect(development.key).toBeUndefined();
            const { key: _packagedKey, ...packagedRest } = packaged;
            const { key: _developmentKey, ...developmentRest } = development;
            expect(packagedRest).toEqual(developmentRest);
          },
        );

        // A packaged host, with the store allowlist: the build is admitted and
        // the handshake completes.
        const packaged = await startBridge(extensionId, surface, { packaged: true });
        try {
          await observeAcceptance(
            SUITE,
            {
              surface,
              browser: channel,
              browserVersion,
              entry: "packaged",
              case: `a packaged host admits the ${store} store build through the store allowlist`,
              settings: () => ({
                ...bridgeSettings(packaged.bridge, surface, "store"),
                build: "store",
                extensionId,
                installationKeyProved: true,
              }),
              observed: "the packaged host completed the handshake and reported the surface connected",
            },
            async () => {
              const view = await packaged.bridge.readInstallationKey(surface);
              expect(view).toBeDefined();
              await provision(worker, context, extensionId, packaged.origin, view!.key);
              await waitForConnected(packaged.bridge, surface, true, worker);
              expect(packaged.bridge.snapshot().surfaces[surface].connected).toBe(true);
            },
          );
        } finally {
          await packaged.close();
        }

        // The same packaged host, with the id named only in the *development*
        // allowlist: the extension is refused, and no credential is handed out.
        const refusing = await startBridge(extensionId, surface, {
          packaged: true,
          allowlist: "development",
        });
        try {
          await observeAcceptance(
            SUITE,
            {
              surface,
              browser: channel,
              browserVersion,
              entry: "packaged",
              case: `a packaged host refuses the ${store} extension named only in the development allowlist`,
              settings: () => ({
                ...bridgeSettings(refusing.bridge, surface, "development"),
                build: "store",
                extensionId,
                installationKeyProved: true,
              }),
              observed: "the packaged host refused the extension and reported no connected surface",
            },
            async () => {
              const view = await refusing.bridge.readInstallationKey(surface);
              await provision(worker, context, extensionId, refusing.origin, view!.key);
              await waitForConnected(refusing.bridge, surface, false, worker);
              expect(refusing.bridge.snapshot().surfaces[surface].connected).toBe(false);
            },
          );
        } finally {
          await refusing.close();
        }
      } finally {
        await context.close();
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
