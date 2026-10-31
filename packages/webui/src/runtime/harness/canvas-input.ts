import type { CliService } from "@mavis/local-runtime-v2/cli-service";
import { WebuiErrorCode, WebuiWireError } from "../../shared/envelope.js";

type CanvasInput = Parameters<CliService["applyCanvas"]>[0];
type CanvasOperation = CanvasInput["operation"];
type CanvasMutation = CanvasOperation["mutations"][number];
type CanvasLayout = Extract<
  CanvasMutation,
  { kind: "update_layout" }
>["layout"];
type CanvasAnnotation = Extract<
  CanvasMutation,
  { kind: "add_annotation" }
>["annotation"];

function invalid(field: string): never {
  throw new WebuiWireError(
    WebuiErrorCode.invalidBody,
    `Invalid canvas input: ${field}`,
  );
}

function record(value: unknown, field: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    invalid(field);
  return value as Record<string, unknown>;
}

function text(value: unknown, field: string): string {
  if (typeof value !== "string") invalid(field);
  return value;
}

function number(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) invalid(field);
  return value;
}

function layout(value: unknown): CanvasLayout {
  const input = record(value, "layout");
  return {
    x: number(input.x, "layout.x"),
    y: number(input.y, "layout.y"),
    width: number(input.width, "layout.width"),
    height: number(input.height, "layout.height"),
    zIndex: number(input.zIndex, "layout.zIndex"),
  };
}

function annotation(value: unknown): CanvasAnnotation {
  const input = record(value, "annotation");
  const rect = record(input.normalizedRect, "annotation.normalizedRect");
  const action = input.action;
  if (action !== "comment" && action !== "erase") invalid("annotation.action");
  return {
    id: text(input.id, "annotation.id"),
    number: number(input.number, "annotation.number"),
    comment: text(input.comment, "annotation.comment"),
    action,
    createdAtMs: number(input.createdAtMs, "annotation.createdAtMs"),
    normalizedRect: {
      x: number(rect.x, "normalizedRect.x"),
      y: number(rect.y, "normalizedRect.y"),
      width: number(rect.width, "normalizedRect.width"),
      height: number(rect.height, "normalizedRect.height"),
    },
  };
}

// Runtime types constrain every reconstructed branch; business validation remains in the host.
const mutations = {
  add_file(input) {
    const nodeId = text(input.nodeId, "nodeId");
    const position = layout(input.layout);
    if (typeof input.relativePath === "string" && input.assetId === undefined) {
      return {
        kind: "add_file",
        nodeId,
        layout: position,
        relativePath: input.relativePath,
      };
    }
    if (typeof input.assetId === "string" && input.relativePath === undefined) {
      return {
        kind: "add_file",
        nodeId,
        layout: position,
        assetId: input.assetId,
      };
    }
    return invalid("add_file requires exactly one file identity");
  },
  update_layout: (input) => ({
    kind: "update_layout",
    nodeId: text(input.nodeId, "nodeId"),
    layout: layout(input.layout),
  }),
  remove_node: (input) => ({
    kind: "remove_node",
    nodeId: text(input.nodeId, "nodeId"),
  }),
  add_annotation: (input) => ({
    kind: "add_annotation",
    nodeId: text(input.nodeId, "nodeId"),
    annotation: annotation(input.annotation),
  }),
  update_annotation: (input) => ({
    kind: "update_annotation",
    nodeId: text(input.nodeId, "nodeId"),
    annotation: annotation(input.annotation),
  }),
  remove_annotation: (input) => ({
    kind: "remove_annotation",
    nodeId: text(input.nodeId, "nodeId"),
    annotationId: text(input.annotationId, "annotationId"),
  }),
} satisfies {
  [Kind in CanvasMutation["kind"]]: (
    input: Record<string, unknown>,
  ) => Extract<CanvasMutation, { kind: Kind }>;
};

const parsers = new Map<
  string,
  (input: Record<string, unknown>) => CanvasMutation
>(Object.entries(mutations));

export function toRuntimeCanvasInput(value: {
  readonly sessionId: string;
  readonly operation: unknown;
}): CanvasInput {
  const operation = record(value.operation, "operation");
  if (operation.schemaVersion !== 1) invalid("schemaVersion");
  const items = operation.mutations;
  if (!Array.isArray(items)) invalid("mutations");
  return {
    sessionId: text(value.sessionId, "sessionId"),
    operation: {
      schemaVersion: 1,
      operationId: text(operation.operationId, "operationId"),
      mutations: items.map((item) => {
        const input = record(item, "mutation");
        const parse = parsers.get(text(input.kind, "mutation.kind"));
        if (!parse) invalid("mutation.kind");
        return parse(input);
      }),
    },
  };
}
