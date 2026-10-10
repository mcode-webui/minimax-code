// MessageAttachments — WebUI transcription of `function e2()` from
// `mine-transcript/58686.pretty.js` (lines 1550–1613) plus the image render
// helper it composes (`function e1()`, lines 1495–1549) and the file-card row
// it composes (the inline `rounded-xl border-[0.5px] bg-bg_default_secondary
// p-2 w-60` block at lines 1588–1609).
//
// In the desktop this is called from `tl` (line 2043) which is what the
// transcript wires under each assistant message. The Desktop source maps
// attachments into image / file buckets (line 1552–1553) and renders each
// bucket separately. The single image case (`a.length === 1`) is intentionally
// full-width and lacks the wrapping `flex flex-wrap gap-2` container (line
// 1562).
//
// `onPreview` is invoked identically to Desktop — `r?.(e)` on click, on
// Enter / Space key. The file-card preview click is wired too.
//
// The actual image bytes come from `ey(t, workspaceDir)` in Desktop (a hook
// that resolves `preview_url || file_path` to a renderer URL via the desktop
// runtime). On the WebUI we just pass `src` through, leaving the integrator
// responsible for hydrating `preview_url` on the message before it reaches the
// component. When `src` is missing the component falls back to the
// "broken-image placeholder" from Desktop's `e1` (lines 1511–1525) so callers
// never see a half-rendered tile.

import { useEffect, useState, type KeyboardEvent, type MouseEvent } from "react";

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
      <div
        className={`flex items-center justify-center rounded-xl bg-bg_default_tertiary border-[0.5px] border-border_default ${
          isSingle ? "w-[120px] h-[80px]" : "w-20 h-20"
        }`}
        data-testid="message-attachment-image-placeholder"
      >
        <div className="flex flex-col items-center gap-1">
          <svg
            className="text-text_default_quaternary"
            width="20"
            height="20"
            viewBox="0 0 20 20"
            aria-hidden="true"
            focusable="false"
          >
            <rect x="2" y="3" width="16" height="14" rx="2" fill="none" stroke="currentColor" strokeWidth="1.5" />
            <circle cx="7" cy="8" r="1.5" fill="currentColor" />
            <path d="M4 14l4-4 3 3 2-2 3 3" fill="none" stroke="currentColor" strokeWidth="1.5" />
          </svg>
          <span
            className="max-w-[100px] truncate text-[10px] text-text_default_quaternary"
            title={attachment.file_name}
          >
            {attachment.file_name}
          </span>
        </div>
      </div>
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
      <div className="flex items-start gap-2">
        <div className="flex size-9 shrink-0 items-center justify-center rounded-md bg-bg_grouped_primary_elevated">
          <svg
            width="18"
            height="18"
            viewBox="0 0 18 18"
            aria-hidden="true"
            focusable="false"
            className="text-icon_default_secondary"
          >
            <path
              d="M4 2h7l3 3v11H4z"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinejoin="round"
            />
            <path d="M11 2v3h3" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
          </svg>
        </div>
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
          <button
            type="button"
            onClick={(event: MouseEvent<HTMLButtonElement>) => {
              event.stopPropagation();
              activate(attachment, onPreview);
            }}
            className="flex size-7 shrink-0 items-center justify-center rounded-md text-icon_default_secondary hover:bg-bg_interaction_tertiary_hover"
            data-testid="message-attachment-file-preview"
            aria-label={`Preview ${attachment.file_name}`}
          >
            <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true" focusable="false">
              <path d="M1 7s2.5-5 6-5 6 5 6 5-2.5 5-6 5-6-5-6-5z" fill="none" stroke="currentColor" strokeWidth="1.4" />
              <circle cx="7" cy="7" r="2" fill="none" stroke="currentColor" strokeWidth="1.4" />
            </svg>
          </button>
        ) : null}
      </div>
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
        <div className="mb-2 flex flex-wrap gap-2">
          {files.map((file) => (
            <AttachmentFile key={file.id} attachment={file} onPreview={onPreview} />
          ))}
        </div>
      ) : null}
    </div>
  );
}