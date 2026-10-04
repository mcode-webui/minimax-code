import { readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import viteConfig from "../../vite.config.js";

const CLIENT_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "src",
  "client",
);

const proxy = viteConfig.server?.proxy ?? {};

/**
 * Vite's own rule for `server.proxy` keys, copied rather than imported:
 * a key starting with `^` is a regex, everything else is a `startsWith`
 * prefix match. Reading the rule out of Vite's source is the only way to
 * know what a key really captures -- and the difference is the whole bug.
 */
function proxyMatches(context: string, url: string): boolean {
  if (context.startsWith("^")) return new RegExp(context).test(url);
  return url.startsWith(context);
}

function capturingContexts(url: string): string[] {
  return Object.keys(proxy).filter((context) => proxyMatches(context, url));
}

function clientModuleUrls(directory = CLIENT_ROOT, found: string[] = []): string[] {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) clientModuleUrls(full, found);
    // Vite serves source modules at their path relative to `root`, which the
    // config sets to `src/client`.
    else found.push(`/${path.relative(CLIENT_ROOT, full).split(path.sep).join("/")}`);
  }
  return found;
}

describe("dev server proxy", () => {
  it("declares a proxy at all", () => {
    expect(Object.keys(proxy)).not.toHaveLength(0);
  });

  it("captures no client module the app has to load", () => {
    // A prefix key silently swallows everything below it, and Vite answers a
    // swallowed module request with a bare 404 -- so `main.tsx` never
    // evaluates and the shell renders blank with no console error. Registering
    // `/session-import` for the HTTP route shadowed `/session-import.ts`,
    // the client module of the same name, and blanked the whole page.
    const shadowed = clientModuleUrls()
      .filter((url) => capturingContexts(url).length > 0)
      .map((url) => `${url} <- ${capturingContexts(url).join(", ")}`);
    expect(shadowed).toEqual([]);
  });

  it("captures the session transfer route with its query string", () => {
    expect(capturingContexts("/session-transfer?sessionId=mvs_1&token=t")).not.toHaveLength(0);
    expect(capturingContexts("/session-import?token=")).not.toHaveLength(0);
  });

  it("sends both transfer routes to the runtime server", () => {
    const targets = Object.entries(proxy)
      .filter(([context]) => proxyMatches(context, "/session-import?token="))
      .map(([context, options]) => [context, (options as { target?: string }).target]);
    expect(targets.length).toBeGreaterThan(0);
    for (const [context, target] of targets) {
      expect(target, `${context} must have a target`).toBeTruthy();
      expect(target, `${context} must not be the websocket scheme`).not.toMatch(/^wss?:/u);
    }
  });
});
