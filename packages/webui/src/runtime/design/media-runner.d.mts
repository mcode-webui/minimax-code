import type { DesignExecutionContext } from "./agent-runner.mjs";
import type { DesignMedia } from "../../shared/contracts/design.js";
export interface ExtractedDesignMediaStore {
  listLibrary(): Promise<(DesignMedia & { id: string; name: string; mimeType: string; bytes: number; createdAt: string })[]>;
  saveUpload(name: string, bytes: Uint8Array, kind?: string): Promise<DesignMedia & Record<string, unknown>>;
  publishBytes(bytes: Uint8Array, extension: string): Promise<DesignMedia>;
  readAsset(name: string): Promise<{ data: Uint8Array; mimeType: string } | null>;
  readUpload(name: string): Promise<{ data: Uint8Array; mimeType: string } | null>;
  removeAsset(name: string): Promise<unknown>;
  refreshVideoUrl(taskId: string, model?: string): Promise<unknown>;
  assetUrl(name: string): string;
  publishRemote(url: string, kind?: string): Promise<string>;
  saveToDownloads(name: string, wanted?: string, targetDir?: string): Promise<unknown>;
  writeToFolder(name: string, bytes: Uint8Array, targetDir?: string): Promise<unknown>;
}
export function createMediaRunner(context: DesignExecutionContext): {
  status(): Promise<Record<string, unknown>>;
  prepareForProvider(media: { url: string }): Promise<string>;
  run(input: { tool: string; sources: readonly DesignMedia[]; params: Readonly<Record<string, unknown>> }): Promise<unknown>;
  dispose(): void;
  store: ExtractedDesignMediaStore;
};
