/**
 * The composer's attachment acquisition, as one binding.
 *
 * The staged attachments live in the composer store (`staging.attachments` /
 * `staging.busy`), so the component only ever read them — while the flow around
 * them was spread over seven places in the file: the file reader, the limit
 * check, the concurrent read, the seed decision, the wire projection, the two hidden
 * inputs and the drop/paste handlers. No single owner existed for "how a file becomes
 * a staged attachment", which is the responsibility this binding takes.
 *
 * A pure move: the seed's mark-then-consume order, the limit error's precedence
 * over reading the file, and the busy window are exactly as they were. The
 * component keeps the JSX wiring, and `interactionError` stays with it because
 * submission, permissions and the questionnaire write that too.
 */
import { useCallback, useEffect } from "react";

import {
  webuiAttachmentLimitError,
  type WebuiComposerAttachment,
} from "../projection/composer-interactions.js";
import {
  readWebuiSeedApplication,
  type WebuiComposerSeed,
} from "../projection/seed-application.js";

/** One staged attachment projected onto the submission wire shape. */
export interface WebuiComposerAttachmentWire {
  readonly meta: {
    readonly attachmentType: WebuiComposerAttachment["kind"];
    readonly fileName: string;
    readonly mimeType: string;
    readonly sizeBytes: number;
  };
  readonly local: { readonly dataUrl: string };
}

export interface UseComposerAttachmentsOptions {
  readonly setStagedAttachments: (update: (current: readonly WebuiComposerAttachment[]) => readonly WebuiComposerAttachment[]) => void;
  readonly setAttachmentBusy: (busy: boolean) => void;
  readonly consumeSeed: (token: string) => void;
  /** The staged attachments, read from the store snapshot by the component. */
  readonly attachments: readonly WebuiComposerAttachment[];
  /** The token of the seed this composer already consumed, if any. */
  readonly seedToken: string | undefined;
  readonly seedAttachment?: WebuiComposerSeed;
  readonly setInteractionError: (message: string | undefined) => void;
}

export interface ComposerAttachments {
  /** Reads browser files into data URLs and stages them, enforcing the limit. */
  readonly addFiles: (filesLike: FileList | readonly File[] | null) => Promise<void>;
  /** Drops every staged attachment (the submission path). */
  readonly clearAttachments: () => void;
  /** Drops one staged attachment by id (the chip's remove affordance). */
  readonly removeAttachment: (id: string) => void;
  /** The staged attachments as the wire carries them. */
  readonly attachmentWire: readonly WebuiComposerAttachmentWire[];
}

function readBrowserFile(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error(`无法读取文件：${file.name}`));
    reader.onload = () => typeof reader.result === "string"
      ? resolve(reader.result)
      : reject(new Error(`无法读取文件：${file.name}`));
    reader.readAsDataURL(file);
  });
}

export function useComposerAttachments(
  options: UseComposerAttachmentsOptions,
): ComposerAttachments {
  const { setStagedAttachments, setAttachmentBusy, consumeSeed, attachments, seedToken, seedAttachment, setInteractionError } = options;

  const setAttachments = useCallback(setStagedAttachments, [setStagedAttachments]);

  const addFiles = async (filesLike: FileList | readonly File[] | null) => {
    const files = filesLike ? Array.from(filesLike) : [];
    if (files.length === 0) return;
    const limitError = webuiAttachmentLimitError(attachments, files.map((file) => ({ sizeBytes: file.size })));
    if (limitError) {
      setInteractionError(limitError);
      return;
    }
    setAttachmentBusy(true);
    setInteractionError(undefined);
    try {
      const additions = await Promise.all(files.map(async (file): Promise<WebuiComposerAttachment> => {
        const dataUrl = await readBrowserFile(file);
        const fileName = (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name;
        return {
          id: crypto.randomUUID(),
          fileName,
          mimeType: file.type || "application/octet-stream",
          sizeBytes: file.size,
          dataUrl,
          kind: file.type.startsWith("image/") ? "image" : "file",
        };
      }));
      setAttachments((current) => [...current, ...additions]);
    } catch (error) {
      setInteractionError(error instanceof Error ? error.message : String(error));
    } finally {
      setAttachmentBusy(false);
    }
  };

  // The seed's dependency list is deliberately `[attachments, seedAttachment]`:
  // the decision reads the consumed token through the store rather than through
  // a dependency, so re-running it on the token's own change cannot re-attach a
  // seed the composer just refused.
  useEffect(() => {
    const decision = readWebuiSeedApplication({
      seed: seedAttachment,
      consumedToken: seedToken,
      attachments,
    });
    if (decision.kind === "none") return;
    // Mark it consumed before anything that can bail. A seed the composer
    // refuses has to stay refused; retrying on every attachment change would
    // pin the error in place.
    consumeSeed(decision.token);
    if (decision.kind === "refused") {
      setInteractionError(decision.error);
      return;
    }
    setAttachments((current) => [...current, decision.attachment]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [attachments, consumeSeed, seedAttachment]);

  const attachmentWire = attachments.map((attachment) => ({
    meta: {
      attachmentType: attachment.kind,
      fileName: attachment.fileName,
      mimeType: attachment.mimeType,
      sizeBytes: attachment.sizeBytes,
    },
    local: { dataUrl: attachment.dataUrl },
  }));

  return {
    addFiles,
    clearAttachments: () => setAttachments(() => []),
    removeAttachment: (id: string) => setAttachments((current) => current.filter((item) => item.id !== id)),
    attachmentWire,
  };
}
