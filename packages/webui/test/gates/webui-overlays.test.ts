// The overlay inventory's own rules (#290, ADR 0028 § Overlay coordination).
//
// The gate is only worth running if it fails for the right reasons, so the
// reasons are tested here: an unlisted surface, a `managed` entry whose source
// never registers, an exception with no stated boundary, and a pending entry with
// no reason. The scan itself is a regex over the sources — cheap, and honest
// about what it can see: it finds the two shapes that produce a floating layer,
// not every way one can be written.

import { describe, expect, it } from "vitest";
import { compareOverlays, scanSource } from "../../../../scripts/check-webui-overlays.mjs";

const inventory = {
  files: {
    "a.tsx": { disposition: "managed" },
    "b.tsx": { disposition: "borrows-role" },
  },
};

describe("the overlay inventory", () => {
  it("counts the shapes that produce a floating layer", () => {
    const scanned = scanSource('<div role="dialog"><WebuiDropdown managed open={x} /></div>');
    expect(scanned).toEqual({ dropdowns: 1, dialogs: 1, managed: 1 });
  });

  it("fails on a surface nobody has decided about", () => {
    const problems = compareOverlays({ "c.tsx": { dropdowns: 2, dialogs: 0, managed: 0 } }, inventory);
    expect(problems).toContain("c.tsx: has a floating layer but is not inventoried");
  });

  it("fails when a managed entry does not register", () => {
    const problems = compareOverlays({ "a.tsx": { dropdowns: 1, dialogs: 0, managed: 0 } }, inventory);
    expect(problems).toContain("a.tsx: says managed but no layer registers with the coordinator");
  });

  it("fails when a surface that borrows the dialog role also registers a layer", () => {
    const problems = compareOverlays(
      { "a.tsx": { dropdowns: 0, dialogs: 1, managed: 1 } },
      { files: { "a.tsx": { disposition: "borrows-role" } } },
    );
    expect(problems).toContain("a.tsx: says borrows-role but registers a layer — it is a managed surface");
  });

  it("fails on an entry whose source has gone", () => {
    const problems = compareOverlays({ "a.tsx": { dropdowns: 1, dialogs: 0, managed: 1 } }, inventory);
    expect(problems).toContain("b.tsx: inventoried but produces no floating layer");
  });

  it("needs an exception to state its boundary, and a pending entry its reason", () => {
    const problems = compareOverlays(
      { "a.tsx": { dropdowns: 1, dialogs: 0, managed: 1 } },
      {
        files: {
          "a.tsx": { disposition: "exception" },
          "b.tsx": { disposition: "pending" },
        },
      },
    );
    expect(problems).toContain("a.tsx: an exception needs its interaction boundary stated");
    expect(problems).toContain("b.tsx: pending needs the reason it is not migrated yet");
  });

  it("does not accept a boundary on a managed surface", () => {
    const problems = compareOverlays(
      { "a.tsx": { dropdowns: 1, dialogs: 0, managed: 1 } },
      { files: { "a.tsx": { disposition: "managed", boundary: "nesting is safe" } } },
    );
    expect(problems).toContain("a.tsx: a managed surface is not an exception; drop the boundary note");
  });

  it("records one decision per disposition and none of them proves nesting is safe", () => {
    const problems = compareOverlays(
      { "a.tsx": { dropdowns: 1, dialogs: 0, managed: 1 }, "b.tsx": { dropdowns: 0, dialogs: 1, managed: 0 } },
      {
        files: {
          "a.tsx": { disposition: "managed" },
          "b.tsx": { disposition: "exception", boundary: "a portal outside the document" },
        },
      },
    );
    expect(problems).toEqual([]);
  });
});
