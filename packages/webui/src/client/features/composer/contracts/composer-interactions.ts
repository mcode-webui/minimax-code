export interface WebuiMentionRange {
  readonly start: number;
  readonly end: number;
  readonly query: string;
}

export interface WebuiComposerAttachment {
  readonly id: string;
  readonly fileName: string;
  readonly mimeType: string;
  readonly sizeBytes: number;
  readonly dataUrl: string;
  readonly kind: "image" | "file";
}

export interface WebuiComposerUrlReference {
  readonly id: string;
  readonly url: string;
}
