/**
 * The canvas wire contract.
 *
 * `WebuiTransport` has to name these types, so they are declared here rather
 * than in the canvas component: a transport method cannot take a type defined
 * in a module that sits above it in the dependency chain.
 *
 * Mirrors the runtime's `CanvasOperationV1` in
 * `packages/local-runtime-v2/src/service/canvas/contracts.ts`. The runtime is
 * the authority — it rejects a reused `operationId` with a different payload,
 * an empty `mutations` array, an `add_file` carrying both or neither file
 * identity, a non-positive width or height, and a non-integer `zIndex`.
 */
// Wire contract record (plan section 7.1 / 7.5): every exported
// declaration below records its wire purpose, its producer and its
// consumers, verified against the tree. Documentation only.
//
// | Declaration | Wire purpose | Producer | Consumers |
// | --- | --- | --- | --- |
// | `CanvasNodeLayout` | One node's x/y/width/height/zIndex inside a canvas mutation. | Browser `client/components/WorkspaceCanvas.tsx` (gesture handling). | `client/contracts/workspace-port.ts`; runtime `applyCanvas` (`runtime/harness/workspace.ts`). |
// | `CanvasMutation` | A single add_file / update_layout / remove_node canvas gesture. | Browser `client/components/WorkspaceCanvas.tsx`. | `client/contracts/workspace-port.ts`; runtime `applyCanvas`. |
// | `CanvasOperation` | A batch of mutations plus schemaVersion/operationId sent to the canvas authority. | Browser `client/components/WorkspaceCanvas.tsx`. | `client/contracts/workspace-port.ts`; `client/components/WorkspacePanels.tsx`; runtime `applyCanvas`. |
// | `WebuiCanvasDocument` | The canvas document (nodes, changeSeq) returned by read/apply. | Runtime `readCanvas` / `applyCanvas` (`runtime/harness/workspace.ts`; runtime canvas authority). | `client/contracts/workspace-port.ts`; `client/components/WorkspaceCanvas.tsx`; `client/components/WorkspacePanels.tsx`. |
export interface CanvasNodeLayout {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly zIndex: number;
}

/**
 * A node drag, a node resize and a canvas pan all start from one pointer and
 * one gesture, so the marker on the pointerdown target picks the winner once.
 * `add_file` carries exactly one file identity, as the runtime requires.
 */
export type CanvasMutation =
  | { readonly kind: "add_file"; readonly nodeId: string; readonly layout: CanvasNodeLayout; readonly relativePath: string }
  | { readonly kind: "add_file"; readonly nodeId: string; readonly layout: CanvasNodeLayout; readonly assetId: string }
  | { readonly kind: "update_layout"; readonly nodeId: string; readonly layout: CanvasNodeLayout }
  | { readonly kind: "remove_node"; readonly nodeId: string };

export interface CanvasOperation {
  readonly schemaVersion: 1;
  readonly operationId: string;
  readonly mutations: readonly CanvasMutation[];
}

export interface WebuiCanvasDocument {
  readonly schemaVersion: number;
  readonly canvasId: string;
  readonly sessionId: string;
  readonly changeSeq: number;
  readonly nodes: readonly Record<string, unknown>[];
  readonly updatedAtMs: number;
}
