// The shell's seam and its startup duties.
//
// The foundation shell has three jobs: render the supplied APIs, hold the routing/layout/startup
// duties, and construct no duplicate business owner. The seam condition is that the shell forwards
// **zero** transport members, and the slices are what satisfy it: each business reads its own slice
// and the shell passes slice-derived values, never `transport.X`.
//
// Source assertions, like the rest of the shell's structural coverage: the claim is about which
// expressions exist, and this package has no DOM to observe them in. A `transport.` read outside a
// comment, a second `createWebuiPortSlices` call, a second channel, or a boundary moved inside the
// shell each turns a case red.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const read = (relative: string): string =>
  readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8");

const shell = read("../../src/client/shell/WebuiClientFoundationApp.tsx");
const main = read("../../src/client/main.tsx");

describe("the shell forwards zero transport members", () => {
  it("never reads a member off the composed transport in code", () => {
    // The prop stays (SSR and the unit tests drive it, and its optionality is what preserves the
    // not-wired mode), and the type is imported for it. What must not exist is a *read*.
    const mentions = shell
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => /transport\./u.test(line));
    expect(mentions.length).toBeGreaterThan(0);
    for (const line of mentions) {
      expect(line, `transport member read in code: ${line}`).toMatch(/^(?:\/\/|\*|\/\*|import)/u);
    }
  });

  it("cuts no port slices of its own: the composition root cuts them once", () => {
    // The port-slice cut moved out of the shell entirely. The seam this case guards is
    // unchanged — the shell forwards zero transport members — so a second cut
    // inside it, or the fallback coming back, turns the case red.
    expect(shell.match(/createWebuiPortSlices\(/gu) ?? []).toHaveLength(0);
    expect(main.match(/createWebuiPortSlices\(/gu) ?? []).toHaveLength(1);
  });
});

describe("the shell keeps its startup duties", () => {
  it("constructs no application of its own", () => {
    // The alternate factory is gone: the shell renders the
    // application the composition root assembled, and a missing one is a named
    // assembly error rather than a second composition with different inputs.
    expect(shell).not.toMatch(/createWebuiApplication\(\{/u);
    expect(shell).toContain("requireApplication(");
    expect(shell).toContain("WebUI assembly error");
  });

  it("opens no event channel and disposes no application", () => {
    // Both belong to the entry that owns the instance: the shell neither opens
    // the ingress nor ends a lifetime it did not begin.
    expect(shell.match(/createWebuiOpenEventChannel\(/gu) ?? []).toHaveLength(0);
    expect(shell).not.toContain("application.dispose()");
  });

  it("leaves the lifecycle to the entry", () => {
    // One construct, one start and one dispose per boot.
    expect(main).toContain("application.start({ initialSessionId:");
    expect(main).toContain("application.dispose()");
  });

  it("leaves the error boundary at the composition root", () => {
    // The boundary catches a render failure in the tree *above* the shell; placing it inside would
    // leave the shell's own render uncovered.
    expect(main).toContain("<WebuiErrorBoundary>");
    expect(shell).not.toContain("<WebuiErrorBoundary");
  });
});
