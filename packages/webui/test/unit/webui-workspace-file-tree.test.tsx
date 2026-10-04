// Unit tests for the workspace file tree's file-metadata column.
//
// `WebuiWorkspaceFile.size` (bytes) and `.modifiedAt` (epoch ms) are optional
// by contract: absent for directories, and absent for any runtime that does
// not stat. So the load-bearing case here is absence — a tree from such a
// runtime must render the same row chrome minus the metadata, and must never
// print `undefined`, `NaN` or `Invalid Date`. The sizes and times are asserted
// on the markup rather than on a locale-dependent string, so these cases stay
// true in any timezone.

import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { FileTree, formatWorkspaceFileModifiedAt, formatWorkspaceFileSize } from "../../src/client/components/WorkspaceFileTree.js";
import type { WebuiWorkspaceFile } from "../../src/server/port.js";

const MODIFIED_AT = Date.UTC(2026, 9, 4, 8, 51);

function renderTree(
  files: readonly WebuiWorkspaceFile[],
  overrides: {
    readonly expandedPaths?: ReadonlySet<string>;
    readonly loadingPaths?: ReadonlySet<string>;
    readonly directoryErrors?: Readonly<Record<string, string>>;
    readonly selectedPath?: string;
  } = {},
): string {
  return renderToStaticMarkup(createElement(FileTree, {
    files,
    onOpen: () => undefined,
    expandedPaths: overrides.expandedPaths ?? new Set<string>(),
    loadingPaths: overrides.loadingPaths ?? new Set<string>(),
    directoryErrors: overrides.directoryErrors ?? {},
    onToggle: () => undefined,
    selectedPath: overrides.selectedPath,
  }));
}

describe("workspace file tree metadata column", () => {
  it("renders a binary size and a UTC timestamp beside a stat-ed file", () => {
    const markup = renderTree([
      { path: "src/index.ts", name: "index.ts", type: "file", size: 1258291, modifiedAt: MODIFIED_AT },
    ]);

    expect(markup).toContain("index.ts");
    expect(markup).toContain("1.2 MB");
    expect(markup).toContain("2026-10-04 08:51");
    expect(markup).toContain("webui-file-tree-meta");
    expect(markup).not.toContain("undefined");
    expect(markup).not.toContain("NaN");
    expect(markup).not.toContain("Invalid Date");
  });

  it("keeps the existing row contract: class, button type, selection and expansion", () => {
    const markup = renderTree(
      [
        {
          path: "src",
          name: "src",
          type: "directory",
          children: [{ path: "src/a.ts", name: "a.ts", type: "file", size: 10, modifiedAt: MODIFIED_AT }],
        },
      ],
      { expandedPaths: new Set(["src"]), selectedPath: "src" },
    );

    expect(markup).toContain('<button type="button" class="webui-file-tree-row is-selected"');
    expect(markup).toContain('aria-current="true"');
    expect(markup).toContain('aria-expanded="true"');
    expect(markup).toContain("webui-expandable-motion is-open");
    expect(markup).toContain('aria-hidden="false"');
    // The child file still carries its own metadata inside the expanded tree.
    expect(markup).toContain("10 B");
  });

  it("renders the metadata without a container element when both fields are missing", () => {
    const markup = renderTree([{ path: "src/legacy.ts", name: "legacy.ts", type: "file" }]);

    expect(markup).toContain("legacy.ts");
    expect(markup).not.toContain("webui-file-tree-meta");
    expect(markup).not.toContain("undefined");
    expect(markup).not.toContain("NaN");
    expect(markup).not.toContain("Invalid Date");
    // The name still owns the truncating box, so the row does not reflow.
    expect(markup).toContain('class="min-w-0 flex-1 truncate">legacy.ts</span>');
  });

  it("keeps whichever half the runtime did send when only one field is present", () => {
    const sizeOnly = renderTree([{ path: "a.bin", name: "a.bin", type: "file", size: 2048 }]);
    expect(sizeOnly).toContain("2 KB");
    expect(sizeOnly).not.toContain("webui-file-tree-meta shrink-0 text-size_12 leading-line_height_16 text-text_default_tertiary\"> ·");

    const timeOnly = renderTree([{ path: "b.bin", name: "b.bin", type: "file", modifiedAt: MODIFIED_AT }]);
    expect(timeOnly).toContain("2026-10-04 08:51");
  });

  it("shows neither size nor time for a directory, even if a runtime sends them", () => {
    const markup = renderTree([
      { path: "src", name: "src", type: "directory", size: 4096, modifiedAt: MODIFIED_AT },
    ]);

    expect(markup).toContain('aria-expanded="false"');
    expect(markup).toContain("src");
    expect(markup).not.toContain("4 KB");
    expect(markup).not.toContain("2026-10-04");
    expect(markup).not.toContain("webui-file-tree-meta");
  });

  it("formats byte-size boundaries and promotes the unit before rounding", () => {
    const cases = [
      { bytes: 0, expected: "0 B" },
      { bytes: 999, expected: "999 B" },
      { bytes: 1024, expected: "1 KB" },
      { bytes: 348160, expected: "340 KB" },
      { bytes: 1048575, expected: "1 MB" },
    ] as const;
    const markup = renderTree(cases.map((entry, index) => ({
      path: `f${index}.bin`,
      name: `f${index}.bin`,
      type: "file",
      size: entry.bytes,
    })));

    for (const { expected } of cases) expect(markup).toContain(expected);
    // 1048575 is 1 B short of a megabyte: binary units promote, they never
    // render a 1024 KB row.
    expect(markup).not.toContain("1024 KB");
  });

  it("drops unusable numbers instead of printing NaN or Invalid Date", () => {
    expect(formatWorkspaceFileSize(Number.NaN)).toBeUndefined();
    expect(formatWorkspaceFileSize(-1)).toBeUndefined();
    expect(formatWorkspaceFileModifiedAt(Number.NaN)).toBeUndefined();
    // One millisecond past the largest representable Date.
    expect(formatWorkspaceFileModifiedAt(8.64e15 + 1)).toBeUndefined();

    const markup = renderTree([
      { path: "broken.bin", name: "broken.bin", type: "file", size: Number.NaN, modifiedAt: Number.POSITIVE_INFINITY },
      { path: "unreachable.bin", name: "unreachable.bin", type: "file", modifiedAt: 8.64e15 + 1 },
    ]);
    expect(markup).toContain("broken.bin");
    expect(markup).not.toContain("NaN");
    expect(markup).not.toContain("Invalid Date");
    expect(markup).not.toContain("webui-file-tree-meta");
  });

  it("formats a fixed-width UTC timestamp independent of the host timezone", () => {
    // 2026-01-01T00:30Z: 23:30 on 2025-12-31 in UTC+1, 01:30 in UTC+9. A
    // locale formatter would disagree with the host; the UTC read is fixed.
    expect(formatWorkspaceFileModifiedAt(Date.UTC(2026, 0, 1, 0, 30))).toBe("2026-01-01 00:30");
    expect(formatWorkspaceFileModifiedAt(Date.UTC(2026, 0, 1, 23, 5))).toBe("2026-01-01 23:05");
    expect(formatWorkspaceFileModifiedAt(0)).toBe("1970-01-01 00:00");
  });
});
