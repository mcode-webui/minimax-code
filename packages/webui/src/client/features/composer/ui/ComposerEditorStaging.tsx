// The composer editor's staging row and its two typed popups.
//
// This is the part of the composer that sits under the textarea: the attachment
// and URL-reference chips, the `@` mention list and the `/` command palette.
// Eighty-eight lines of the composer render read fifteen of its cells directly;
// they arrive here as named props instead — the chips report the three edits
// they can make rather than receiving store setters, and the two lists report
// the cursor intent they raise.
//
// What stayed with the composer is what the popups cannot own: the mention and
// command cursors, because the textarea's own key handling moves them; and the
// gate that decides whether the mention list shows at all, because it depends on
// the range the editor tracks.
//
// The two popups are dropdowns now: the shared skeleton owns their surface,
// their motion, their placement and their dismissal. Neither of them has a
// trigger — a list that follows the caret is opened by a keystroke, not by a
// button — so they are the skeleton in its triggerless shape, and they name the
// region they belong to instead.

import { Fragment, type RefObject } from "react";
import { IconX } from "@tabler/icons-react";

import { WebuiDropdown, type WebuiDropdownPlacementArgs } from "../../../ui/Dropdown.js";
import type { WebuiClientSession } from "../../sessions/contracts/session-view.js";
import {
  type WebuiComposerAttachment,
  type WebuiComposerUrlReference,
} from "../projection/composer-interactions.js";
import type { SlashCommandEntry } from "./slash-palette.js";

/** One row the `@` list can offer. */
export type WebuiComposerMentionChoice =
  | { readonly kind: "plugin"; readonly name: string; readonly label: string; readonly detail?: string; readonly section: string }
  | { readonly kind: "file"; readonly path: string; readonly label: string; readonly section: string }
  | { readonly kind: "local-file"; readonly label: string; readonly section: string }
  | { readonly kind: "local-folder"; readonly label: string; readonly section: string }
  | { readonly kind: "agent"; readonly session: WebuiClientSession; readonly label: string; readonly section: string };

/** One row the `/` palette can offer. */
export type WebuiComposerCommandSuggestion = SlashCommandEntry;

export interface WebuiComposerEditorStagingProps {
  readonly attachments: readonly WebuiComposerAttachment[];
  readonly urlReferences: readonly WebuiComposerUrlReference[];
  readonly attachmentBusy: boolean;
  readonly onRemoveAttachment: (id: string) => void;
  readonly onChangeReference: (id: string, url: string) => void;
  readonly onRemoveReference: (id: string) => void;
  /** Present only while the editor has a live mention range with choices. */
  readonly mention?: {
    readonly choices: readonly WebuiComposerMentionChoice[];
    readonly index: number;
    readonly onIndexChange: (index: number) => void;
    readonly onChoose: (choice: WebuiComposerMentionChoice) => void;
  };
  readonly commands: readonly WebuiComposerCommandSuggestion[];
  readonly commandIndex: number;
  readonly onCommandIndexChange: (index: number) => void;
  readonly onChooseCommand: (name: string) => void;
  /**
   * The element the two popups are measured against.
   *
   * It is the composer's input box — the frame the text sits in — and not the
   * caret: a caret has no rectangle, and a list that hangs off a point in a
   * line of text would have to be placed by measuring the text, which is a
   * different thing from hanging off the box the text is in.
   */
  readonly anchorRef: RefObject<HTMLElement | null>;
  /**
   * The region a press inside is NOT a dismissal.
   *
   * It is the composer's whole region, because both popups belong to the
   * composer: a press anywhere in it — the text, the attachments, the send
   * button — is the user still working, not the user leaving.
   */
  readonly dismissRegionRef: RefObject<HTMLElement | null>;
  /** Closes the mention range. */
  readonly onDismissMention: () => void;
  /** Cancels the slash invocation, exactly as Escape does. */
  readonly onDismissCommand: () => void;
}

/**
 * The palette's placement.
 *
 * It spans the composer's input box less a margin on each side, and it opens
 * ABOVE the box — the way a command palette is read — unless there is no room
 * there, in which case it opens below. When neither side has room for the
 * whole panel, the panel is kept inside the viewport and scrolls: a palette
 * whose last rows are below the fold is a palette the reader cannot use, and
 * a palette that is off the screen entirely is worse.
 *
 * The direction is decided HERE, from the measured panel and the viewport, and
 * not by the composer beforehand. The panel's own height is the thing that
 * decides it, and the panel's height is only known here — a measurement taken
 * elsewhere guesses it, and a guess that is wrong puts the palette on the
 * wrong side of the input box, running off the bottom of the screen.
 */
const COMMAND_PALETTE_INSET = 12;
const COMMAND_PALETTE_GAP = 8;
const COMMAND_PALETTE_MARGIN = 8;

function placeCommandPalette({
  anchor,
  surface,
  viewport,
}: WebuiDropdownPlacementArgs): {
  readonly left: number;
  readonly top: number;
  readonly width: string;
  readonly side: "top" | "bottom";
} {
  const width = Math.max(0, anchor.width - COMMAND_PALETTE_INSET * 2);
  const roomAbove = anchor.top - COMMAND_PALETTE_GAP - COMMAND_PALETTE_MARGIN;
  const roomBelow = viewport.height - (anchor.top + anchor.height + COMMAND_PALETTE_GAP) - COMMAND_PALETTE_MARGIN;
  // Above is the palette's own side: it opens upwards unless there is no room
  // for it there, and it opens downwards only when downwards is the side with
  // more room.
  const above = surface.height <= roomAbove || roomAbove >= roomBelow;
  const rawTop = above
    ? anchor.top - COMMAND_PALETTE_GAP - surface.height
    : anchor.top + anchor.height + COMMAND_PALETTE_GAP;
  // Kept inside the viewport on both axes, so a palette that is taller than
  // the space it asked for starts at the top edge and scrolls rather than
  // hanging off the bottom.
  const top = Math.min(
    Math.max(rawTop, COMMAND_PALETTE_MARGIN),
    Math.max(COMMAND_PALETTE_MARGIN, viewport.height - COMMAND_PALETTE_MARGIN - surface.height),
  );
  const left = Math.min(
    Math.max(anchor.left + COMMAND_PALETTE_INSET, COMMAND_PALETTE_MARGIN),
    Math.max(COMMAND_PALETTE_MARGIN, viewport.width - COMMAND_PALETTE_MARGIN - width),
  );
  return { left: Math.round(left), top: Math.round(top), width: `${width}px`, side: above ? "top" : "bottom" };
}

export function WebuiComposerEditorStaging({
  attachments,
  urlReferences,
  attachmentBusy,
  onRemoveAttachment,
  onChangeReference,
  onRemoveReference,
  mention,
  commands,
  commandIndex,
  onCommandIndexChange,
  onChooseCommand,
  anchorRef,
  dismissRegionRef,
  onDismissMention,
  onDismissCommand,
}: WebuiComposerEditorStagingProps) {
  const references = (key: string) =>
    urlReferences.map((reference) => (
      <div key={`${key}:${reference.id}`} className="webui-composer-url-reference">
        <span aria-hidden="true">↗</span>
        <input
          aria-label="URL 引用"
          value={reference.url}
          onChange={(event) => onChangeReference(reference.id, event.target.value)}
        />
        <button type="button" aria-label="移除 URL 引用" onClick={() => onRemoveReference(reference.id)}><IconX aria-hidden="true" size={14} stroke={1.7} /></button>
      </div>
    ));
  return (
    <>
      {attachments.length > 0 ? (
        <div className="webui-composer-attachments" data-webui-composer-attachments="true">
          {attachments.map((attachment) => (
            <div key={attachment.id} className={`webui-composer-attachment${attachment.kind === "image" ? " is-image" : ""}`}>
              {attachment.kind === "image" ? <img src={attachment.dataUrl} alt={attachment.fileName} /> : <span className="webui-composer-attachment-type">{attachment.fileName.split(".").pop()?.toUpperCase() ?? "FILE"}</span>}
              <span className="webui-composer-attachment-name" title={attachment.fileName}>{attachment.fileName}</span>
              <button type="button" aria-label={`移除 ${attachment.fileName}`} onClick={() => onRemoveAttachment(attachment.id)}><IconX aria-hidden="true" size={14} stroke={1.7} /></button>
            </div>
          ))}
          {references("attached")}
          {attachmentBusy ? <span className="webui-composer-attachment-loading" role="status">正在读取文件…</span> : null}
        </div>
      ) : urlReferences.length > 0 ? (
        <div className="webui-composer-attachments" data-webui-composer-attachments="true">{references("lone")}</div>
      ) : null}
      {mention && mention.choices.length > 0 ? (
        <WebuiDropdown
          managed
          managedLayerId="composer-mention"
          open
          onOpen={() => undefined}
          onClose={onDismissMention}
          role="listbox"
          ariaLabel="提及列表"
          className="webui-composer-mention-menu"
          popupDataAttributes={{ "data-webui-mention-menu": "true" }}
          side="top"
          align="start"
          offset={8}
          collision="clamp"
          anchorElementRef={anchorRef}
          dismissRegionRef={dismissRegionRef}
        >
          {mention.choices.map((choice, index) => (
            <Fragment key={`${choice.section}:${choice.kind}:${choice.kind === "agent" ? choice.session.sessionId : choice.label}`}>
              {index === 0 || mention.choices[index - 1]?.section !== choice.section ? <div className="webui-composer-mention-section">{choice.section}</div> : null}
              <button type="button" role="option" aria-selected={index === mention.index} className="webui-composer-mention-option" onMouseDown={(event) => event.preventDefault()} onMouseEnter={() => mention.onIndexChange(index)} onClick={() => mention.onChoose(choice)}>
                <span>{choice.label}</span>
                {choice.kind === "plugin" && choice.detail ? <small>{choice.detail}</small> : null}
              </button>
            </Fragment>
          ))}
        </WebuiDropdown>
      ) : null}
      {commands.length > 0 ? (
        <WebuiDropdown
          managed
          managedLayerId="composer-command"
          open
          onOpen={() => undefined}
          onClose={onDismissCommand}
          role="listbox"
          ariaLabel="命令"
          className="webui-command-menu"
          popupDataAttributes={{ "data-webui-command-menu": "true" }}
          placement={placeCommandPalette}
          anchorElementRef={anchorRef}
          dismissRegionRef={dismissRegionRef}
        >
          {commands.map((command, index) => {
            const Icon = command.icon;
            const inert = !command.supported;
            const isFirstSkill =
              command.paletteSection === "skills" &&
              (index === 0 || commands[index - 1]?.paletteSection !== "skills");
            return (
              <Fragment key={command.name}>
                {isFirstSkill ? (
                  <div role="separator" data-webui-command-section="skills" className="webui-command-section-header">
                    技能
                  </div>
                ) : null}
                <button
                  type="button"
                  role="option"
                  aria-selected={index === commandIndex}
                  aria-disabled={inert || undefined}
                  disabled={inert}
                  data-webui-command-option-inert={inert ? "true" : undefined}
                  className="webui-command-option"
                  onMouseDown={(event) => event.preventDefault()}
                  onMouseEnter={() => {
                    if (inert) return;
                    onCommandIndexChange(index);
                  }}
                  onClick={() => {
                    if (inert) return;
                    onChooseCommand(command.name);
                  }}
                >
                  <Icon className="webui-command-option-icon text-icon_default_secondary" />
                  <span className="webui-command-option-label">{command.label}</span>
                  <span className="webui-command-option-description text-text_default_tertiary">{command.description}</span>
                </button>
              </Fragment>
            );
          })}
        </WebuiDropdown>
      ) : null}
    </>
  );
}
