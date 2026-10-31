// The single session state source.
//
// The `sessions` owner holds the session store (the single writable copy), the
// catalog read model, per-session activity ownership, and the context-window
// consumption published for the composer's ring. This file is a **check** rather
// than a description: these are the assertions, so a second copy introduced later
// fails here rather than being noticed in review.
//
// Every scan below reads source text. That is deliberate: "there is no second map"
// is a structural claim, and the webui suite has no DOM to observe it in.

import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";

const CLIENT_ROOT = new URL("../../src/client/", import.meta.url);

const read = (relative: string): string =>
  readFileSync(new URL(relative, CLIENT_ROOT), "utf8");
const flat = (text: string): string => text.replace(/\s+/gu, " ");

/**
 * Every `client/**` module, as a path relative to `client/`.
 *
 * Recursive on purpose, and rooted at the whole client rather than one layer: the
 * activity controller lives in `features/sessions/application`, so a walker
 * that only saw `application/**` would pass *because it could no longer
 * find* the second constructor — the exact failure this suite exists to catch.
 */
const appModules = (): string[] => {
  const out: string[] = [];
  const walk = (dir: string, prefix: string): void => {
    for (const entry of readdirSync(new URL(dir, CLIENT_ROOT), {
      withFileTypes: true,
    })) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(`${dir}${entry.name}/`, relative);
      else if (entry.name.endsWith(".ts")) out.push(relative);
    }
  };
  walk("", "");
  return out;
};

describe("the session state source is single", () => {
  it("holds the session map in exactly one module", () => {
    const holders = appModules().filter((name) =>
      /new Map<string, WebuiApplicationSessionState>/.test(read(name)),
    );
    expect(holders).toEqual(["application/session-store.ts"]);
  });

  it("constructs the session activity controller in exactly one module", () => {
    const callers = appModules().filter((name) =>
      read(name).includes("createWebuiSessionActivityController("),
    );
    expect(callers.sort()).toEqual([
      "application/create-application.ts",
      "features/sessions/application/session-activity-controller.ts",
    ]);
  });

  it("derives the shell's page from the catalog instead of holding sessions", () => {
    const shell = flat(read("shell/WebuiClientFoundationApp.tsx"));
    // The catalog is a subscription to the application store...
    expect(shell).toContain("selectWebuiCatalogFlatPage(catalog)");
    expect(shell).toContain("useSyncExternalStore(");
    // ...and the shell keeps no sessions array of its own.
    expect(shell).not.toMatch(/useState<readonly WebuiClientSession\[\]>/u);
    expect(shell).not.toMatch(/useState<WebuiClientSessionPage/u);
  });

  it("reads the context-window consumption from the records that own it, and writes it to neither", () => {
    const composer = flat(read("features/composer/ui/WebuiComposer.tsx"));
    // Read: the live turn's own reading, on the stream slice the application
    // store owns...
    expect(composer).toContain("stream.contextUsage");
    // ...and the history's reading, on the transcript page the same store
    // owns.
    expect(composer).toContain("readContextUsageFromPage(transcript.page)");
    // Write: none. A history reading written onto the live turn's record was
    // the record's second, unowned fact: a turn starting again reset it, and a
    // page read that lost its race with a refresh left the ring blank with
    // nothing to retry it.
    expect(composer).not.toContain("lifecycle.setContextUsage(");
    expect(composer).not.toMatch(/setContextUsage/u);
    // The ring takes it as a value; it holds no usage state of its own.
    expect(composer).toContain("<ContextUsageIndicator usage={contextUsage}");
    expect(composer).not.toMatch(/useState<WebuiContextUsage/u);
  });
});
