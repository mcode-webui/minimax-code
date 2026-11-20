import type { DesignDocument, DesignDocumentSummary } from "../../shared/contracts/design.js";
export function normalizeCanvas(input: unknown, existing?: unknown): DesignDocument;
export function createCanvasStore(context: { dataDir: string }): {
  list(): Promise<DesignDocumentSummary[]>;
  get(id: string): Promise<DesignDocument | null>;
  save(document: DesignDocument | Record<string, unknown>): Promise<DesignDocument>;
  remove(id: string): Promise<boolean>;
  normalizeCanvas: typeof normalizeCanvas;
};
