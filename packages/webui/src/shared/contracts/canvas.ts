export interface WebuiCanvasDocument {
  readonly schemaVersion: number;
  readonly canvasId: string;
  readonly sessionId: string;
  readonly changeSeq: number;
  readonly nodes: readonly Record<string, unknown>[];
  readonly updatedAtMs: number;
}
