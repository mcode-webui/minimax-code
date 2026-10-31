import { describe, expect, it, vi } from "vitest";
import type { CliService } from "@mavis/local-runtime-v2/cli-service";
import { createHarnessPortFromHost } from "../../src/runtime/harness/adapter.js";
import { toRuntimeCanvasInput } from "../../src/runtime/harness/canvas-input.js";
import {
  toWebuiReviewSummary,
  toWebuiSessionPage,
  toWebuiSessionTreePage,
  toWebuiSessionDiff,
} from "../../src/runtime/harness/result-conversion.js";

type CanvasInput = Parameters<CliService["applyCanvas"]>[0];
type CanvasResult = Awaited<ReturnType<CliService["applyCanvas"]>>;
type SessionPage = Awaited<ReturnType<CliService["listSessions"]>>;

const layout = { x: 0, y: 1, width: 100, height: 200, zIndex: 1 };
const annotation = {
  id: "a1",
  number: 1,
  normalizedRect: { x: 0, y: 0, width: 0.5, height: 0.5 },
  comment: "fixture",
  action: "comment" as const,
  createdAtMs: 1,
};

describe("host input adaptation stays inside WebUI", () => {
  it("reconstructs all Canvas mutation kinds before the actual host call", async () => {
    const applyCanvas = vi.fn(
      async (request: CanvasInput): Promise<CanvasResult> => ({
        operationId: request.operation.operationId,
        document: {
          schemaVersion: 1,
          canvasId: "canvas",
          sessionId: request.sessionId,
          changeSeq: 1,
          nodes: [],
          updatedAtMs: 1,
        },
      }),
    );
    // Only the invoked leaf is scripted; the production adapter and its decoder are real.
    const port = createHarnessPortFromHost({
      apiHost: { close: async () => {} },
      cliService: { applyCanvas } as never,
    });
    const input = {
      sessionId: "s1",
      operation: {
        schemaVersion: 1 as const,
        operationId: "operation",
        mutations: [
          { kind: "add_file", nodeId: "n1", relativePath: "a.txt", layout },
          { kind: "add_file", nodeId: "n2", assetId: "asset", layout },
          { kind: "update_layout", nodeId: "n1", layout },
          { kind: "remove_node", nodeId: "n2" },
          { kind: "add_annotation", nodeId: "n1", annotation },
          { kind: "update_annotation", nodeId: "n1", annotation },
          { kind: "remove_annotation", nodeId: "n1", annotationId: "a1" },
        ],
      },
    };
    await expect(port.applyCanvas!(input)).resolves.toMatchObject({
      operationId: "operation",
      document: { sessionId: "s1" },
    });
    expect(applyCanvas).toHaveBeenCalledExactlyOnceWith(input);
    const sent = applyCanvas.mock.calls[0]![0];
    expect(sent).not.toBe(input);
    expect(sent.operation.mutations).not.toBe(input.operation.mutations);
  });

  it.each([
    { kind: "unknown", nodeId: "n1" },
    { kind: "add_file", nodeId: "n1", relativePath: "a", assetId: "b", layout },
    {
      kind: "update_layout",
      nodeId: "n1",
      layout: { ...layout, width: "100" },
    },
    {
      kind: "add_annotation",
      nodeId: "n1",
      annotation: { ...annotation, action: "unknown" },
    },
    { kind: "remove_annotation", nodeId: "n1" },
  ])(
    "refuses malformed Canvas input before invoking the host: $kind",
    async (mutation) => {
      const invalidFields: Record<string, string> = {
        unknown: "mutation.kind",
        add_file: "add_file requires exactly one file identity",
        update_layout: "layout.width",
        add_annotation: "annotation.action",
        remove_annotation: "annotationId",
      };
      const applyCanvas = vi.fn();
      const port = createHarnessPortFromHost({
        apiHost: { close: async () => {} },
        cliService: { applyCanvas } as never,
      });
      await expect(
        port.applyCanvas!({
          sessionId: "s1",
          operation: {
            schemaVersion: 1,
            operationId: "op",
            mutations: [mutation],
          },
        }),
      ).rejects.toMatchObject({
        code: "invalid_body",
        message: `Invalid canvas input: ${invalidFields[mutation.kind]}`,
      });
      expect(applyCanvas).not.toHaveBeenCalled();
    },
  );

  it("rejects an unreadable envelope without fabricating an operation", () => {
    expect(() =>
      toRuntimeCanvasInput({
        sessionId: "s1",
        operation: { schemaVersion: 2, mutations: [] },
      }),
    ).toThrow("Invalid canvas input: schemaVersion");
  });
});

describe("typed host results become independently owned WebUI DTOs", () => {
  const page = {
    sessions: [
      {
        sessionId: "s1",
        agentName: "main",
        sessionType: 1,
        sessionKind: 2,
        createdAt: 1,
        updatedAt: 2,
        workspaceDir: "/synthetic",
        archived: false,
        status: { statusType: 0 },
        frameworkType: "pi-agent",
        isDefaultWorkspace: false,
        visibility: "visible",
        interactionMode: 0,
        memoryPolicy: {
          recallEnabled: true,
          writeEnabled: true,
          recallLocked: false,
        },
      },
    ],
    hasMore: true,
    nextCursor: "next",
  } satisfies SessionPage;

  it("translates numeric session semantics and preserves pagination", () => {
    expect(toWebuiSessionPage(page)).toMatchObject({
      sessions: [
        {
          sessionId: "s1",
          agentName: "main",
          sessionType: "root",
          sessionKind: "task",
        },
      ],
      hasMore: true,
      nextCursor: "next",
    });
    expect(page.sessions[0].sessionType).toBe(1);
    expect(
      toWebuiSessionTreePage({
        sessions: [
          {
            session: page.sessions[0],
            childSessions: [
              { ...page.sessions[0], sessionId: "child", compressed: false },
            ],
          },
        ],
        hasMore: false,
      }),
    ).toMatchObject({
      sessions: [
        {
          childSessions: [
            { sessionId: "child", agentName: "main", sessionKind: "task" },
          ],
        },
      ],
    });
  });

  it("maps review identity and counts using the actual host result", () => {
    const review = {
      repositoryId: "repo",
      reviewSnapshotId: "snapshot",
      source: { type: "workspace" },
      files: [
        {
          fileId: "file",
          path: "a.txt",
          status: "modified",
          revision: "r1",
          additions: 2,
          deletions: 1,
        },
      ],
      totals: { files: 1, additions: 2, deletions: 1 },
    } satisfies Awaited<ReturnType<CliService["getWorkspaceReviewSummary"]>>;
    expect(toWebuiReviewSummary(review)).toEqual({
      repositoryId: "repo",
      reviewSnapshotId: "snapshot",
      files: [
        {
          fileId: "file",
          path: "a.txt",
          status: "modified",
          additions: 2,
          deletions: 1,
        },
      ],
      totals: { files: 1, additions: 2, deletions: 1 },
    });
    expect(() =>
      toWebuiReviewSummary({ ...review, reviewSnapshotId: "" }),
    ).toThrow("a review snapshot id");
  });

  it("uses the host diff's file path rather than inventing a review file id", () => {
    const diff = {
      file: "a.txt",
      additions: 2,
      deletions: 1,
      patch: { oldFileName: "a.txt", newFileName: "a.txt" },
    };
    expect(
      toWebuiSessionDiff({ diffs: [diff], changeSetId: "changes" }),
    ).toEqual({
      diffs: [diff],
      changeSetId: "changes",
    });
  });
});
