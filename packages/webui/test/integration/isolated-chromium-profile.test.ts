// The isolated Chromium's profile outlives the browser.
//
// The profile is the browser's state: the sessions the person signed into, the
// cookies, the storage. A host that deleted it on every close threw away
// every login each time it restarted, and the person had to sign in again to
// every site the Agent had been working with.
//
// The case drives a real browser against a real origin, because what is being
// proved is what the browser writes to disk: a cookie set on an http origin, a
// browser that is closed and relaunched, and the cookie that is still there.
// A file left in a directory would not say that — Chrome writes its state
// when it exits, and a browser that was killed instead of closed loses
// whatever it had not flushed.

import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { WebuiIsolatedChromiumProvider } from "../../src/runtime/browser/isolated-chromium/provider.js";
import { resolveChromeExecutable } from "./chrome-executable.js";

/** The cookie the origin hands out. Its name says what it is for. */
const COOKIE_NAME = "mavis-session";
const COOKIE_VALUE = "kept";

/** The budget every case in this file is given. */
const BROWSER_CASE_BUDGET_MS = 60_000;

/** How often a page is asked whether it has reached the state a case waits for. */
const POLL_MS = 50;

/** How long a page is given to reach the state a case waits for. */
const WAIT_MS = 5_000;

/**
 * Waits for a condition to hold.
 *
 * The condition is asked again every `POLL_MS` until it holds, and a
 * condition that throws is the page's own state rather than the flow's
 * failure — a page that is loading answers a read with an error — so it is
 * asked again, and the last of those errors is reported if the wait ends
 * without the condition holding.
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
    await new Promise<void>((resolve) => setTimeout(resolve, POLL_MS));
  }
  throw new Error(
    `timed out waiting for ${description}${lastError === undefined ? "" : `: ${String(lastError)}`}`,
  );
}

/**
 * An origin that hands out a persistent cookie.
 *
 * A persistent cookie — one with a lifetime — is what a login is: a session
 * cookie without one is meant to die with the browser, and Chrome would
 * rightly not carry it across a restart.
 */
function startOrigin(): Promise<{ server: Server; url: string }> {
  const server = createServer((_request, response) => {
    response.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "set-cookie": `${COOKIE_NAME}=${COOKIE_VALUE}; Max-Age=3600; Path=/`,
    });
    response.end("<!doctype html><title>profile</title><p>origin</p>");
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as AddressInfo).port;
      resolve({ server, url: `http://127.0.0.1:${port}/` });
    });
  });
}

/** The cookie the page behind the browser's selection can see. */
async function readCookie(
  provider: WebuiIsolatedChromiumProvider,
): Promise<string> {
  const selected = (await provider.listTargets()).find((entry) => entry.selected);
  if (!selected) throw new Error("the provider reported no selected target");
  const result = (await provider.sendCommand(selected.id, "Runtime.evaluate", {
    expression: "document.cookie",
    returnByValue: true,
  })) as { result?: { value?: unknown } } | undefined;
  return typeof result?.result?.value === "string" ? result.result.value : "";
}

/** Points the browser at the origin and waits for the page to be there. */
async function visit(
  provider: WebuiIsolatedChromiumProvider,
  url: string,
): Promise<void> {
  const selected = (await provider.listTargets()).find((entry) => entry.selected);
  if (!selected) throw new Error("the provider reported no selected target");
  await provider.sendCommand(selected.id, "Page.navigate", { url });
  await waitFor(
    async () => (await readCookie(provider)).includes(COOKIE_NAME),
    "the page to load the origin's cookie",
  );
}

const available = (await resolveChromeExecutable()) !== undefined;

describe.skipIf(!available)("the isolated Chromium's profile", () => {
  let dataDir: string;
  let origin: { server: Server; url: string };

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "webui-isolated-profile-"));
    origin = await startOrigin();
  }, 60_000);

  afterAll(async () => {
    await new Promise<void>((resolve) => origin?.server.close(() => resolve()));
    if (dataDir) await rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  it("keeps what the person signed into across a restart", async () => {
    const first = await WebuiIsolatedChromiumProvider.launch({ dataDir });
    await visit(first, origin.url);
    expect(await readCookie(first)).toContain(`${COOKIE_NAME}=${COOKIE_VALUE}`);
    await first.close();

    // The profile is the browser's state, and it belongs to the host: a
    // restart must not throw away what the person signed into.
    const profileDir = join(dataDir, "browser", "isolated-chromium", "profile");
    await expect(stat(profileDir)).resolves.toBeDefined();

    const second = await WebuiIsolatedChromiumProvider.launch({ dataDir });
    try {
      await visit(second, origin.url);
      expect(await readCookie(second)).toContain(`${COOKIE_NAME}=${COOKIE_VALUE}`);
    } finally {
      await second.close();
    }
  }, BROWSER_CASE_BUDGET_MS);
});
