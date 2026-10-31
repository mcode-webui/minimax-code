// MessageAttachments — the attachments rendered under an assistant message:
// image tiles plus a file-card row, which uses the inline
// `rounded-xl border-[0.5px] bg-bg_default_secondary p-2 w-60` block.
//
// The transcript wires this under each assistant message. Attachments are
// bucketed into images and files, and each bucket renders separately. The
// single-image case is intentionally full-width and lacks the wrapping
// `flex flex-wrap gap-2` container.
//
// `onPreview` fires on click and on Enter / Space key. The file-card preview
// click is wired too.
//
// Image bytes arrive as `src`: the component passes the URL through, leaving
// the integrator responsible for hydrating `preview_url` on the message before
// it reaches the component. `preview_url ?? file_path` is what resolves to a
// renderer URL. When `src` is missing the component falls back to the
// "broken-image placeholder" so callers never see a half-rendered tile.

import { useEffect, useState, type KeyboardEvent, type MouseEvent } from "react";
import { IconEye, IconFileText, IconPhoto } from "@tabler/icons-react";
import { WebuiIconButton } from "../../../ui/button.js";
import { WebuiInline, WebuiStack } from "../../../ui/layout-primitives.js";

// The attachment shape lives in contracts.ts (so projection/message-projection.ts
// can return it without importing the React component). Re-export it under the
// historical name so every existing importer keeps its path unchanged.
import type { WebuiMessageAttachment as MessageAttachment, WebuiMessageAttachmentType as MessageAttachmentType } from "../contracts/message-view.js";
export type { MessageAttachment, MessageAttachmentType };

export interface MessageAttachmentsProps {
  attachments: readonly MessageAttachment[];
  onPreview?: (attachment: MessageAttachment) => void;
  workspaceDir?: string | null;
}

function activate(
  attachment: MessageAttachment,
  onPreview?: (attachment: MessageAttachment) => void,
) {
  onPreview?.(attachment);
}

function handleKeyDown(
  event: KeyboardEvent<HTMLDivElement>,
  attachment: MessageAttachment,
  onPreview?: (attachment: MessageAttachment) => void,
): void {
  if (event.key === "Enter" || event.key === " ") {
    event.preventDefault();
    activate(attachment, onPreview);
  }
}

function AttachmentImage(props: {
  attachment: MessageAttachment;
  isSingle: boolean;
  onPreview?: (attachment: MessageAttachment) => void;
}): React.JSX.Element {
  const { attachment, isSingle, onPreview } = props;
  const [errored, setErrored] = useState(false);
  const src = attachment.src ?? attachment.preview_url ?? attachment.file_path;

  useEffect(() => {
    setErrored(false);
  }, [src]);

  if (errored || !src) {
    return (
      <WebuiInline
        align="center"
        justify="center"
        className={`rounded-xl bg-bg_default_tertiary border-[0.5px] border-border_default ${
          isSingle ? "w-[120px] h-[80px]" : "w-20 h-20"
        }`}
        data-testid="message-attachment-image-placeholder"
      >
        <WebuiStack gap="tight" align="center">
          <IconPhoto className="text-text_default_quaternary" width={20} height={20} aria-hidden="true" focusable="false" stroke={1.6} />
          <span
            className="max-w-[100px] truncate text-[10px] text-text_default_quaternary"
            title={attachment.file_name}
          >
            {attachment.file_name}
          </span>
        </WebuiStack>
      </WebuiInline>
    );
  }

  return (
    <div
      className="cursor-pointer"
      role="button"
      tabIndex={0}
      onClick={() => activate(attachment, onPreview)}
      onKeyDown={(event) => handleKeyDown(event, attachment, onPreview)}
      data-testid="message-attachment-image"
    >
      <div
        className={`relative overflow-hidden rounded-xl ${
          isSingle ? "w-full h-full" : "w-20 h-20"
        }`}
      >
        <img
          src={src}
          alt={attachment.file_name}
          onError={() => setErrored(true)}
          className={isSingle ? "w-full h-full object-cover" : "h-full w-full object-cover"}
          data-testid="message-attachment-image-img"
        />
      </div>
    </div>
  );
}

function AttachmentFile(props: {
  attachment: MessageAttachment;
  onPreview?: (attachment: MessageAttachment) => void;
}): React.JSX.Element {
  const { attachment, onPreview } = props;
  const href = attachment.preview_url || attachment.file_path;
  return (
    <div
      className="w-60 rounded-xl border-[0.5px] border-border_default bg-bg_default_secondary p-2 transition-colors hover:bg-bg_interaction_tertiary_hover"
      data-testid="message-attachment-file"
    >
      <WebuiInline align="start" gap="small">
        <WebuiInline justify="center" className="size-9 shrink-0 rounded-md bg-bg_grouped_primary_elevated">
          <IconFileText width={18} height={18} aria-hidden="true" focusable="false" className="text-icon_default_secondary" stroke={1.6} />
        </WebuiInline>
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium leading-5 text-text_default_primary">
            {attachment.file_name}
          </div>
          {attachment.file_size ? (
            <div className="text-xs leading-4 text-text_default_tertiary">
              {formatFileSize(attachment.file_size)}
            </div>
          ) : null}
        </div>
        {href ? (
          <WebuiIconButton
            tone="surface"
            size="compact"
            onClick={(event: MouseEvent<HTMLButtonElement>) => {
              event.stopPropagation();
              activate(attachment, onPreview);
            }}
            className="flex size-7 shrink-0 items-center justify-center rounded-md text-icon_default_secondary hover:bg-bg_interaction_tertiary_hover"
            data-testid="message-attachment-file-preview"
            label={`Preview ${attachment.file_name}`}
          >
            <IconEye width={14} height={14} aria-hidden="true" focusable="false" stroke={1.6} />
          </WebuiIconButton>
        ) : null}
      </WebuiInline>
    </div>
  );
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${Math.round(bytes / 1024 / 1024)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GB`;
}

export function MessageAttachments(props: MessageAttachmentsProps): React.JSX.Element | null {
  const { attachments, onPreview, workspaceDir } = props;

  if (attachments.length === 0) return null;

  const images = attachments.filter((entry) => entry.type === "image");
  const files = attachments.filter((entry) => entry.type === "file");

  return (
    <div
      className="mt-4"
      data-testid="message-attachments"
      data-workspace-dir={workspaceDir ?? undefined}
    >
      {images.length > 0 ? (
        <div className="mb-2">
          <div
            className={images.length === 1 ? "" : "flex flex-wrap gap-2"}
            style={images.length === 1 ? undefined : { maxWidth: "432px" }}
          >
            {images.map((image) => (
              <AttachmentImage
                key={image.id}
                attachment={image}
                isSingle={images.length === 1}
                onPreview={onPreview}
              />
            ))}
          </div>
        </div>
      ) : null}
      {files.length > 0 ? (
        <WebuiInline gap="small" wrap className="mb-2">
          {files.map((file) => (
            <AttachmentFile key={file.id} attachment={file} onPreview={onPreview} />
          ))}
        </WebuiInline>
      ) : null}
    </div>
  );
}
