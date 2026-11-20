/** Native Design documents retain the MIT-licensed AI Node Canvas 1.22.9 format. */
export type DesignKind = "text" | "image" | "video" | "audio";
export type DesignNodeType = "input" | "text" | "image" | "video" | "audio" | "result" | "group";
export interface DesignMedia {
  readonly url: string;
  readonly kind: DesignKind;
  readonly name?: string;
  readonly local?: boolean;
  readonly nodeId?: string;
  readonly taskId?: string;
  readonly model?: string;
  readonly bytes?: number;
  readonly mimeType?: string;
  readonly createdAt?: string;
  readonly width?: number;
  readonly height?: number;
}
export interface DesignLibraryAsset extends DesignMedia { readonly id: string; readonly name: string; readonly title: string; readonly canvasId: string; readonly inUse: boolean }
export interface DesignVoice { readonly value: string; readonly label: string }
export interface DesignExportPlaces { readonly home: string; readonly downloads: string; readonly desktop: string; readonly documents: string; readonly sep: string }
export interface DesignDraft { readonly document: DesignDocument; readonly baseDocument: DesignDocument; readonly revision: string; readonly savedAt: string }
export interface DesignDraftEdit {
  readonly nodeId: string;
  readonly baseNode: DesignNode;
  readonly patch: { readonly title?: string; readonly metadata?: Partial<Pick<DesignNodeMetadata, "prompt" | "segments" | "mentions" | "templateId" | "templateText" | "templateVars">> };
}
export type DesignExportSource = { readonly type: "document_template" } | { readonly type: "template"; readonly templateId: string } | { readonly type: "media"; readonly media: DesignMedia };
export interface DesignNodeOutput {
  readonly status: "idle" | "loading" | "success" | "error" | "interrupted";
  readonly text: string;
  readonly media: readonly DesignMedia[];
  readonly error: string;
  readonly [key: string]: unknown;
}
export interface DesignNodeMetadata {
  readonly kind: DesignKind;
  readonly prompt: string;
  readonly mode: string | null;
  readonly model: string | null;
  readonly ratio: string | null;
  readonly resolution: string | null;
  readonly duration: number | null;
  readonly count: number;
  readonly voice: string | null;
  readonly emotion: string | null;
  readonly sessionId: string | null;
  readonly segments: readonly ({ readonly type: "text"; readonly text: string } | { readonly type: "mention"; readonly nodeId: string; readonly kind: DesignKind })[];
  readonly mentions: readonly { readonly nodeId: string; readonly kind: DesignKind }[];
  readonly output: DesignNodeOutput;
  readonly templateId?: string;
  readonly templateText?: string;
  readonly templateVars?: Readonly<Record<string, string>>;
  readonly userSized?: boolean;
  readonly sourceNodeId?: string;
  readonly sourceTaskId?: string;
  readonly [key: string]: unknown;
}
export interface DesignNode {
  readonly id: string;
  readonly type: DesignNodeType;
  readonly title: string;
  readonly position: { readonly x: number; readonly y: number };
  readonly width: number;
  readonly height: number;
  readonly metadata: DesignNodeMetadata;
}
export interface DesignConnection {
  readonly id: string;
  readonly fromNodeId: string;
  readonly toNodeId: string;
  readonly kind: string;
  readonly role?: string;
}
export interface DesignDocument {
  readonly id: string;
  readonly title: string;
  readonly nodes: readonly DesignNode[];
  readonly connections: readonly DesignConnection[];
  readonly backgroundMode: "dots" | "lines";
  readonly viewport: { readonly x: number; readonly y: number; readonly k: number };
  readonly createdAt: string;
  /** Opaque revision, compared inside the runtime's document write lock. */
  readonly updatedAt: string;
}
export interface DesignDocumentSummary {
  readonly id: string;
  readonly title: string;
  readonly nodeCount: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}
export interface DesignTemplate {
  readonly id: string;
  readonly title?: string;
  readonly name?: string;
  readonly description?: string;
  readonly nodes?: readonly Record<string, unknown>[];
  readonly connections?: readonly Record<string, unknown>[];
  readonly [key: string]: unknown;
}
export interface DesignTask {
  readonly id: string;
  readonly nodeId?: string | null;
  readonly status: string;
  readonly mode?: string;
  readonly error?: string | null;
  readonly elapsedMs?: number;
  readonly providerStatus?: string;
  readonly sessionId?: string | null;
  readonly log?: readonly string[];
  readonly startedAt?: number;
  readonly finishedAt?: number;
  readonly [key: string]: unknown;
}
export interface DesignModel {
  readonly key: string;
  readonly label: string;
  readonly providerId?: string;
  readonly modelId?: string;
  readonly [key: string]: unknown;
}
export interface DesignOpenIntent {
  readonly id: string;
  readonly sessionId: string;
  readonly documentId: string;
  readonly createdAt: string;
}
export interface DesignState {
  readonly documents: readonly DesignDocumentSummary[];
  readonly document?: DesignDocument;
  readonly templates: readonly DesignTemplate[];
  /** Original node palette, limits, prompt templates and media tool definitions. */
  readonly capabilities: Readonly<Record<string, unknown>>;
  readonly models: readonly DesignModel[];
  readonly defaultModelKey: string | null;
  readonly tasks: readonly DesignTask[];
  readonly library: readonly DesignLibraryAsset[];
  readonly voices?: readonly DesignVoice[];
  readonly voiceError?: string;
  readonly voiceSource?: string;
  readonly exportPlaces?: DesignExportPlaces;
  readonly draft?: DesignDraft;
  readonly mediaStatus: Readonly<Record<string, unknown>>;
  readonly openIntent?: DesignOpenIntent;
  /** Materializing actions retain their payload and include the exact createdNodeIds from their locked append. */
  readonly result?: unknown;
  /** Revision committed by this action; the returned observation may already be newer. */
  readonly committedRevision?: string;
}
export interface GetDesignStateRequest {
  readonly sessionId?: string;
  readonly documentId?: string;
}
export type DesignAction =
  | { readonly type: "open"; readonly title?: string }
  | { readonly type: "create"; readonly title?: string }
  | { readonly type: "set_media_poster"; readonly nodeId: string; readonly sourceUrl: string; readonly base64: string }
  | { readonly type: "save"; readonly document: DesignDocument }
  | { readonly type: "remove" }
  | { readonly type: "add_node"; readonly nodeType: DesignNodeType; readonly title?: string; readonly prompt?: string; readonly kind?: DesignKind; readonly mode?: string; readonly x?: number; readonly y?: number; readonly templateId?: string; readonly templateText?: string }
  | { readonly type: "update_node"; readonly nodeId: string; readonly patch: Readonly<Record<string, unknown>> }
  | { readonly type: "remove_node"; readonly nodeId: string }
  | { readonly type: "connect"; readonly from: string; readonly to: string; readonly role?: string }
  | { readonly type: "disconnect"; readonly connectionId: string }
  | ({ readonly type: "apply_template" } & ({ readonly templateId: string; readonly template?: never } | { readonly template: DesignTemplate; readonly templateId?: never }))
  | { readonly type: "save_template"; readonly template: DesignTemplate }
  | { readonly type: "remove_template"; readonly templateId: string }
  | { readonly type: "run"; readonly nodeId: string; readonly chain?: boolean }
  | { readonly type: "cancel"; readonly taskId: string }
  | { readonly type: "answer"; readonly taskId: string; readonly requestId?: string; readonly answers: readonly unknown[] }
  | { readonly type: "permission"; readonly taskId: string; readonly requestId: string; readonly decision: "allowOnce" | "deny" }
  | { readonly type: "upload"; readonly name: string; readonly kind: DesignKind; readonly base64: string }
  | { readonly type: "publish"; readonly name: string; readonly base64: string; readonly sourceNodeId?: string }
  | { readonly type: "transform"; readonly tool: string; readonly url: string; readonly sourceNodeId?: string }
  | { readonly type: "understand"; readonly kind: DesignKind; readonly url: string; readonly prompt?: string; readonly sourceNodeId?: string }
  | { readonly type: "media_tool"; readonly tool: string; readonly sources: readonly DesignMedia[]; readonly params: Readonly<Record<string, unknown>>; readonly sourceNodeId?: string }
  | { readonly type: "remove_media"; readonly name: string }
  | { readonly type: "refresh_media"; readonly media: DesignMedia }
  | { readonly type: "export"; readonly name: string; readonly media: DesignMedia }
  | { readonly type: "gc_library" }
  | { readonly type: "list_voices" }
  | { readonly type: "places" }
  | { readonly type: "export_file"; readonly path: string; readonly source: DesignExportSource; readonly overwrite?: boolean }
  | { readonly type: "save_draft"; readonly document: DesignDocument; readonly baseDocument: DesignDocument; readonly draftRevision?: string }
  | { readonly type: "save_draft_edits"; readonly edits: readonly DesignDraftEdit[]; readonly draftRevision?: string }
  | { readonly type: "restore_draft"; readonly draftRevision: string }
  | { readonly type: "remove_draft"; readonly draftRevision: string };
export interface ApplyDesignActionRequest extends GetDesignStateRequest {
  readonly action: DesignAction;
  readonly expectedRevision?: string;
}
export interface DesignAssetRequest { readonly kind: "assets" | "uploads"; readonly name: string }
export interface DesignAsset { readonly bytes: Uint8Array; readonly mimeType: string }
