import { useCallback, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type RefObject } from "react";
import { findWebuiMentionRange, removeWebuiSlashToken, type WebuiMentionRange, type WebuiSlashRange } from "../projection/composer-interactions.js";
import { resolveWebuiComposerShortcutAction } from "../projection/composer-state.js";
import { parseShortcutBindings, shortcutBaseKey, SHORTCUT_STORAGE_KEY } from "../../../projection/common/shortcuts.js";
import { useWebuiBrowserCapabilities } from "../../../bindings/browser-capabilities.js";
import { shouldRecallWebuiHistory, startWebuiHistoryBrowse, stepWebuiHistoryBrowse, type WebuiHistoryBrowse } from "../application/composer-history.js";

export interface ComposerInputKeyOptions {
  readonly draft: string;
  readonly history: readonly string[];
  readonly mentionRange?: WebuiMentionRange;
  readonly mentionCount: number;
  readonly commandRange?: WebuiSlashRange;
  readonly commandCount: number;
  readonly composerMenu?: string;
  readonly permissionMenuOpen: boolean;
  readonly goalMode: boolean;
  readonly planMode: boolean;
  readonly submitBlocked: boolean;
  readonly setMentionRange: (range: WebuiMentionRange | undefined) => void;
  readonly setComposerMenu: (menu: undefined) => void;
  readonly setPermissionMenuOpen: (open: boolean) => void;
  readonly onDraftChange: (draft: string) => void;
  readonly onHistoryDraftChange?: (draft: string) => void;
  readonly onCancelGoal: () => void;
  readonly onCancelPlan: () => void;
  readonly chooseMention: (index: number) => void;
  readonly chooseCommand: (index: number) => void;
}

export interface ComposerInput {
  readonly textareaRef: RefObject<HTMLTextAreaElement>;
  readonly caret: number;
  readonly setCaret: (caret: number) => void;
  readonly mentionIndex: number;
  readonly setMentionIndex: (index: number | ((current: number) => number)) => void;
  readonly commandIndex: number;
  readonly setCommandIndex: (index: number | ((current: number) => number)) => void;
  readonly historyBrowse: WebuiHistoryBrowse | undefined;
  readonly setHistoryBrowse: (browse: WebuiHistoryBrowse | undefined) => void;
  readonly setPendingCaret: (caret: number) => void;
  readonly edit: (input: {
    readonly value: string;
    readonly caret: number;
    readonly changeDraft: (draft: string) => void;
    readonly mentionRange: WebuiMentionRange | undefined;
    readonly setMentionRange: (range: WebuiMentionRange | undefined) => void;
    readonly setComposerMenu: (menu: undefined) => void;
    readonly setPermissionMenuOpen: (open: boolean) => void;
  }) => void;
  readonly updateCaret: (value: string, caret: number, mentionRange: WebuiMentionRange | undefined, setMentionRange: (range: WebuiMentionRange | undefined) => void) => void;
  readonly applyHistoryDraft: (text: string, changeDraft: (draft: string) => void) => void;
  readonly handleKeyDown: (event: KeyboardEvent<HTMLTextAreaElement>, options: ComposerInputKeyOptions) => void;
}

export function useComposerInput(draft: string, sessionId?: string): ComposerInput {
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const pendingCaret = useRef<number>();
  const mentionCaret = useRef<number>();
  const [caret, setCaret] = useState(0);
  const [mentionIndex, setMentionIndex] = useState(0);
  const [commandIndex, setCommandIndex] = useState(0);
  const [historyBrowse, setHistoryBrowse] = useState<WebuiHistoryBrowse>();
  // The bindings are read when a key is pressed rather than held in state: the
  // settings page can change them while the composer is open, and the next
  // press must follow the binding the user just set.
  const { storage } = useWebuiBrowserCapabilities();

  useEffect(() => setHistoryBrowse(undefined), [sessionId]);

  useLayoutEffect(() => {
    const next = pendingCaret.current;
    const textarea = textareaRef.current;
    if (next === undefined || !textarea) return;
    textarea.focus();
    textarea.setSelectionRange(next, next);
    pendingCaret.current = undefined;
    setCaret(next);
  }, [draft]);

  const edit: ReturnType<typeof useComposerInput>["edit"] = useCallback((input) => {
    input.changeDraft(input.value);
    setHistoryBrowse(undefined);
    mentionCaret.current = input.caret;
    setCaret(input.caret);
    const nextRange = findWebuiMentionRange(input.value, input.caret);
    if (nextRange) {
      input.setComposerMenu(undefined);
      input.setPermissionMenuOpen(false);
    }
    input.setMentionRange(nextRange);
  }, []);

  /**
   * Breaks the line at the caret.
   *
   * `Enter` breaks the line by itself, so this is only reached for a newline
   * bound to a key the browser does not break the line on.
   */
  const insertNewline = useCallback((event: KeyboardEvent<HTMLTextAreaElement>, options: ComposerInputKeyOptions) => {
    const caret = event.currentTarget.selectionStart ?? options.draft.length;
    const value = `${options.draft.slice(0, caret)}\n${options.draft.slice(caret)}`;
    pendingCaret.current = caret + 1;
    edit({
      value,
      caret: caret + 1,
      changeDraft: options.onHistoryDraftChange ?? options.onDraftChange,
      mentionRange: options.mentionRange,
      setMentionRange: options.setMentionRange,
      setComposerMenu: options.setComposerMenu,
      setPermissionMenuOpen: options.setPermissionMenuOpen,
    });
  }, [edit]);

  const updateCaret: ReturnType<typeof useComposerInput>["updateCaret"] = useCallback((value, nextCaret, _mentionRange, setMentionRange) => {
    setCaret(nextCaret);
    setMentionRange(findWebuiMentionRange(value, nextCaret));
  }, []);

  const applyHistoryDraft = useCallback((text: string, changeDraft: (draft: string) => void) => {
    changeDraft(text);
    setCaret(text.length);
    requestAnimationFrame(() => textareaRef.current?.setSelectionRange(text.length, text.length));
  }, []);

  const handleKeyDown = useCallback((event: KeyboardEvent<HTMLTextAreaElement>, options: ComposerInputKeyOptions) => {
    if (options.mentionRange && options.mentionCount > 0) {
      if (event.key === "Escape") { event.preventDefault(); options.setMentionRange(undefined); return; }
      if (event.key === "ArrowDown") { event.preventDefault(); setMentionIndex((current) => (current + 1) % options.mentionCount); return; }
      if (event.key === "ArrowUp") { event.preventDefault(); setMentionIndex((current) => (current - 1 + options.mentionCount) % options.mentionCount); return; }
      if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); options.chooseMention(mentionIndex); return; }
    }
    if (event.key === "Escape" && options.composerMenu) { event.preventDefault(); options.setComposerMenu(undefined); return; }
    if (event.key === "Escape" && options.permissionMenuOpen) { event.preventDefault(); options.setPermissionMenuOpen(false); return; }
    if (event.key === "Escape" && (options.goalMode || options.planMode)) {
      event.preventDefault();
      if (options.goalMode) options.onCancelGoal(); else options.onCancelPlan();
      return;
    }
    if (event.key === "Escape" && options.commandRange) {
      event.preventDefault();
      const next = removeWebuiSlashToken(options.draft, options.commandRange);
      options.onDraftChange(next);
      setCaret(next.length);
      return;
    }
    if (event.key === "Escape" && historyBrowse) {
      event.preventDefault();
      setHistoryBrowse(undefined);
      applyHistoryDraft(historyBrowse.draft, options.onHistoryDraftChange ?? options.onDraftChange);
      return;
    }
    if (options.commandCount === 0 && (event.key === "ArrowUp" || event.key === "ArrowDown")) {
      const position = event.currentTarget.selectionStart ?? 0;
      if (event.key === "ArrowUp") {
        const next = historyBrowse
          ? stepWebuiHistoryBrowse(historyBrowse, "prev", options.history)
          : shouldRecallWebuiHistory(options.draft, position)
            ? startWebuiHistoryBrowse(options.history, options.draft)
            : undefined;
        if (next) {
          event.preventDefault();
          setHistoryBrowse(next);
          applyHistoryDraft(options.history[next.index] ?? "", options.onHistoryDraftChange ?? options.onDraftChange);
          return;
        }
      } else if (historyBrowse) {
        const next = stepWebuiHistoryBrowse(historyBrowse, "next", options.history);
        event.preventDefault();
        setHistoryBrowse(next);
        applyHistoryDraft(next ? options.history[next.index] ?? "" : historyBrowse.draft, options.onHistoryDraftChange ?? options.onDraftChange);
        return;
      }
    }
    if (options.commandCount === 0) {
      const bindings = parseShortcutBindings(storage.getItem(SHORTCUT_STORAGE_KEY));
      const action = resolveWebuiComposerShortcutAction({
        event: {
          key: event.key,
          code: event.code,
          ctrlKey: event.ctrlKey,
          metaKey: event.metaKey,
          altKey: event.altKey,
          shiftKey: event.shiftKey,
        },
        isComposing: event.nativeEvent.isComposing,
        submitBlocked: options.submitBlocked,
        bindings,
      });
      if (action === "submit") {
        event.preventDefault();
        event.currentTarget.form?.requestSubmit();
        return;
      }
      if (action === "newline" && shortcutBaseKey(bindings["composer.newline"]) !== "Enter") {
        event.preventDefault();
        insertNewline(event, options);
        return;
      }
    }
    if (options.commandCount === 0) return;
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setCommandIndex((current) => (current + 1) % options.commandCount);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setCommandIndex((current) => (current - 1 + options.commandCount) % options.commandCount);
    } else if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      options.chooseCommand(commandIndex);
    }
  }, [applyHistoryDraft, commandIndex, historyBrowse, insertNewline, mentionIndex, storage]);

  return {
    textareaRef, caret, setCaret, mentionIndex, setMentionIndex, commandIndex, setCommandIndex,
    historyBrowse, setHistoryBrowse, setPendingCaret: (value) => { pendingCaret.current = value; },
    edit, updateCaret, applyHistoryDraft, handleKeyDown,
  };
}
