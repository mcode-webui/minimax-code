// Presentation atoms the settings surfaces share: the copy of the three
// personalization section hints, the page's button, and the page's dialog
// frame.
//
// The section header these hints hang on is not here: the shared settings
// skeleton in `client/ui/settings-layout.tsx` owns the header, its help
// affordance and the card the content sits in, and every settings page —
// these editors included — renders that frame rather than its own copy.
//
// The hints stay in the settings business because they are this business's
// copy. A tooltip is text the user reads, and a paraphrase that reads fine
// still means two surfaces stop saying the same thing about the same control.
//
// The button and the dialog frame are here for the same reason: they are the
// settings pages' own controls, and a control that each page re-authors is a
// control that drifts. The button renders the shared button contract rather than
// naming its classes; the dialog keeps the scrim-and-surface treatment
// the memory manager established, under a name that says what it is rather
// than which feature happens to use it.

import { useId, type ReactElement, type ReactNode } from "react";
import { WebuiButton } from "../../../ui/button.js";
import { WebuiDialog } from "../../../ui/dialog.js";
import { FeedbackAnnouncement } from "../../../ui/feedback.js";
import { useWebuiBrowserCapabilities } from "../../../bindings/browser-capabilities.js";

export const PERSONALIZATION_SECTION_HINTS = {
  globalInstructions:
    "定义 Agent 应该如何工作、回答和执行任务，为此设备上的所有 Agent 提供额外指令和上下文。",
  userProfile: "告诉 Agent 你的背景和长期偏好。",
  memory: "设置在此电脑上如何收集、保留和整合本地记忆。",
} as const;

/**
 * The settings pages' button.
 *
 * `compact` is the row-action size: a settings row is 56px tall, and a
 * full-width 80px button in a row's control slot reads as the row's primary
 * action rather than as the action it is. The `min-width` is what a centred
 * action like 退出登录 wants; a two-character action does not.
 *
 * The variant's class name is spelled out rather than composed, because the
 * stylesheet's component layer is pruned against the sources that use it: a
 * class name that only ever appears inside a template literal is a class the
 * build drops.
 */
/**
 * The settings callers' variant names, mapped onto the shared contract's.
 *
 * The names stay because they are what the settings pages say; the appearance,
 * the states and the class string belong to `client/ui/button.tsx` now, and this
 * module adapts rather than copies.
 */
const SETTINGS_BUTTON_VARIANT = {
  gray: "secondary",
  black: "primary",
  danger: "danger",
} as const;

export function SettingsButton({
  children,
  variant = "gray",
  size = "regular",
  disabled = false,
  onClick,
  testId,
  type = "button",
  className,
}: {
  readonly children: ReactNode;
  readonly variant?: keyof typeof SETTINGS_BUTTON_VARIANT;
  readonly size?: "regular" | "compact" | "header";
  readonly disabled?: boolean;
  readonly onClick?: () => void;
  readonly testId?: string;
  readonly type?: "button" | "submit";
  readonly className?: string;
}): ReactElement {
  return (
    <WebuiButton
      type={type}
      disabled={disabled}
      onClick={onClick}
      data-testid={testId}
      variant={SETTINGS_BUTTON_VARIANT[variant]}
      size={size}
      className={className}
    >
      {children}
    </WebuiButton>
  );
}

/**
 * The settings pages' confirmation that a write landed.
 *
 * Three settings surfaces say 已保存 after a write, and each of them said it in
 * its own paragraph. Two problems came with that. The paragraph was a plain
 * `<p>`, so a screen reader never heard it: it appeared silently, and the user
 * who cannot see the green text has no idea the write landed. And each surface
 * wrote the same words in the same place, so the confirmation drifted with the
 * surfaces rather than with the shared family.
 *
 * So the confirmation lives here. The words are the settings pages' own — a
 * tooltip is text the user reads, and a paraphrase that reads fine still means
 * two surfaces stop saying the same thing about the same event.
 *
 * The live region is always in the DOM and its content changes when the state
 * changes. A live region that is inserted together with its text is announced
 * inconsistently across screen readers; one that is already there and then
 * changes is announced reliably. That is why `message` is empty when there is
 * nothing to say rather than the whole element being absent.
 */
export function SettingsSavedNotice({
  message,
  testId,
}: {
  readonly message: ReactNode;
  readonly testId?: string;
}): ReactElement {
  return (
    <>
      <p data-testid={testId} className="webui-personalization-saved" aria-hidden="true">
        {message}
      </p>
      <FeedbackAnnouncement message={message} />
    </>
  );
}

/**
 * The settings pages' dialog: a scrim, a surface, a header with a close
 * button, and a body the caller fills.
 *
 * The scrim is what makes a dialog a dialog. The workspace's commit dialog
 * floats without one, which suits a confirm that appears over work the user
 * is still looking at; a dialog that lists thirty days of history does not,
 * because the list it floats over competes with the list it holds.
 */
export function SettingsDialog({
  title,
  children,
  footer,
  onClose,
  testId,
  width = "narrow",
  variant = "default",
  dismissOnMaskClick = false,
}: {
  readonly title: string;
  readonly children: ReactNode;
  readonly footer?: ReactNode;
  readonly onClose: () => void;
  readonly testId?: string;
  readonly width?: "narrow" | "wide";
  /**
   * `preview` drops the frame: the surface is the preview itself. The account
   * page's share preview is the image it is about to save, and a card around a
   * card would say something the Desktop does not.
   */
  readonly variant?: "default" | "preview";
  /**
   * Whether a click on the scrim closes the dialog.
   *
   * The dialogs that carry a close button in their header do not need this:
   * they say how to leave. A preview that shows the image it is about to save
   * has no such button, so the scrim is the way out — clicking anywhere
   * outside the preview dismisses it.
   */
  readonly dismissOnMaskClick?: boolean;
}): ReactElement {
  const { dom } = useWebuiBrowserCapabilities();
  const dialogId = useId();
  if (variant === "preview") {
    return (
      <SettingsPreviewDialog title={title} onClose={onClose} testId={testId}>
        {children}
      </SettingsPreviewDialog>
    );
  }

  return (
    <WebuiDialog
      id={`settings-dialog-${dialogId}`}
      title={title}
      onClose={onClose}
      width={width === "wide" ? "standard" : "compact"}
      dismissOnEscape={dismissOnMaskClick}
      dismissOnBackdrop={dismissOnMaskClick}
      portalTarget={dom.portalTarget()}
      testId={testId}
      footer={footer}
    >
      {children}
    </WebuiDialog>
  );
}

function SettingsPreviewDialog({
  title,
  children,
  onClose,
  testId,
}: {
  readonly title: string;
  readonly children: ReactNode;
  readonly onClose: () => void;
  readonly testId?: string;
}): ReactElement {
  const { dom } = useWebuiBrowserCapabilities();
  return (
    <WebuiDialog id="settings-preview" title={title} onClose={onClose} dismissOnEscape dismissOnBackdrop portalTarget={dom.portalTarget()} width="standard" testId={testId}>
      {children}
    </WebuiDialog>
  );
}
