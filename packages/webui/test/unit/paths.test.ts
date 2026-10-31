// The client's two pure path rules (U19).
//
// The "last segment" rule was written out at eight call sites and had drifted
// into two dialects: `/`-only splitting, and both separators. Three of them
// used `??` as the fallback, which never fired — `split(...).at(-1)` on a
// string always returns a string — so a path ending in a separator produced an
// empty label instead of falling back. This file pins the rule those sites now
// share, including the case they got wrong.
import { describe, expect, it } from "vitest";

import {
  basenamePath,
  looksLikeAbsoluteWorkspacePath,
} from "../../src/client/projection/common/paths.js";

describe("basenamePath", () => {
  it("takes the last segment of a POSIX path", () => {
    expect(basenamePath("/home/you/project/src/index.ts")).toBe("index.ts");
  });

  it("takes the last segment of a Windows path", () => {
    // The `/`-only copies returned the whole path here, which is what the
    // backslash-aware copies already treated as a bug.
    expect(basenamePath("C:\\Users\\you\\project\\index.ts")).toBe("index.ts");
    expect(basenamePath("C:/Users/you/project/index.ts")).toBe("index.ts");
  });

  it("does not produce an empty label for a trailing separator", () => {
    expect(basenamePath("/home/you/project/")).toBe("project");
    expect(basenamePath("C:\\Users\\you\\project\\")).toBe("project");
  });

  it("falls back to the value when there is no segment to take", () => {
    expect(basenamePath("/")).toBe("/");
    expect(basenamePath("")).toBe("");
  });

  it("keeps a relative path with no separator as-is", () => {
    expect(basenamePath("MEMORY.md")).toBe("MEMORY.md");
    expect(basenamePath("src/index.ts")).toBe("index.ts");
  });
});

describe("looksLikeAbsoluteWorkspacePath", () => {
  it("accepts the three absolute spellings", () => {
    expect(looksLikeAbsoluteWorkspacePath("/home/you/project")).toBe(true);
    expect(looksLikeAbsoluteWorkspacePath("C:\\Users\\you\\project")).toBe(true);
    expect(looksLikeAbsoluteWorkspacePath("C:/Users/you/project")).toBe(true);
    expect(looksLikeAbsoluteWorkspacePath("\\\\server\\share")).toBe(true);
  });

  it("rejects relative and empty values", () => {
    expect(looksLikeAbsoluteWorkspacePath("my-project")).toBe(false);
    expect(looksLikeAbsoluteWorkspacePath("./my-project")).toBe(false);
    expect(looksLikeAbsoluteWorkspacePath("")).toBe(false);
  });
});
