// The 关于你 editor. One of the three co-visible editors `PersonalizationSettings.tsx` composes,
// moved out of that file with its own lifecycle: it reads the profile view, keeps a three-field draft
// (narrowed by `pickProfileFields`, so a save can never carry the view's `path` or `sizeBytes` into a
// request that takes only the three), and saves through `setUserProfile`.
//
// `isProfileSaveable` is exported for the same reason it was exported from the parent: it is the save
// button's three states as one predicate, and `renderToStaticMarkup` paints one frame and never
// resolves a read, so the transition has to be testable directly.

import { useCallback, useEffect, useState, type ReactElement } from "react";

import type {
  WebuiUserProfileFields,
  WebuiUserProfileView,
} from "../../../../shared/contracts/personalization.js";
import { SettingsSection } from "../../../ui/settings-layout.js";
import { WebuiTextarea } from "../../../ui/field.js";
import { WebuiInline } from "../../../ui/layout-primitives.js";
import { PERSONALIZATION_SECTION_HINTS, SettingsButton, SettingsSavedNotice } from "./settings-atoms.js";
import { FeedbackError } from "../../../ui/feedback.js";

const PROFILE_PLACEHOLDER = "告诉 Agent 你的背景和长期偏好……";

/**
 * The editable half of a profile view.
 *
 * Narrowing here rather than passing the whole view around keeps the draft a
 * plain three-field record, so an update cannot accidentally carry the server's
 * `path` or `sizeBytes` back into a `setUserProfile` request that only accepts
 * the three.
 */
function pickProfileFields(view: WebuiUserProfileView): WebuiUserProfileFields {
  // The two short fields only exist in the *file* layer, so a runtime that
  // answers without them leaves the view short two fields. The draft is
  // narrowed to strings here rather than trusted to carry them: a missing
  // field is a blank field, and reading `.length` off it used to take the
  // whole section down with it.
  return {
    nickname: view.nickname ?? "",
    occupation: view.occupation ?? "",
    moreAbout: view.moreAbout ?? "",
  };
}

/** Field-by-field, so the dirty check is not a string-concatenation trap. */
function fieldsEqual(
  left: WebuiUserProfileFields,
  right: WebuiUserProfileFields,
): boolean {
  return (
    left.nickname === right.nickname &&
    left.occupation === right.occupation &&
    left.moreAbout === right.moreAbout
  );
}

/**
 * The save button's three states, as one predicate.
 *
 * Exported so the transition can be tested directly: `renderToStaticMarkup`
 * paints one frame and never resolves the read, so every assertion made through
 * it sees the pre-load state — where the button is disabled for an unrelated
 * reason and would stay green with this check deleted.
 */
export function isProfileSaveable(
  draft: WebuiUserProfileFields | undefined,
  baseline: WebuiUserProfileFields | undefined,
  options: { readonly malformed: boolean; readonly overLimit: boolean; readonly canWrite: boolean },
): boolean {
  if (draft === undefined || !options.canWrite) return false;
  if (options.malformed || options.overLimit) return false;
  // No baseline yet means the read has not landed, which is the same "there is
  // nothing to save" state as an untouched form.
  if (baseline === undefined) return false;
  return !fieldsEqual(draft, baseline);
}

interface UserProfileSectionProps {
  readonly getUserProfile?: () => Promise<WebuiUserProfileView>;
  readonly setUserProfile?: (request: {
    readonly nickname: string;
    readonly occupation: string;
    readonly moreAbout: string;
  }) => Promise<WebuiUserProfileView>;
}

/**
 * 关于你 — the marked region of `user.md`, as the three fields it holds.
 *
 * The region is a structured record on disk: a `Nickname: ` line, an
 * `Occupation: ` line, then a `## More about you` heading followed by free text.
 * Editing it as one blob is what made an untouched profile render as a full page
 * of text — the skeleton itself is what the user was being shown. So each field
 * gets its own control, and the region is never exposed as a string.
 *
 * The three fields are still only part of the file. The same `user.md` carries
 * `mem-append-reason` entries the memory collector appends, and the
 * `<user_profile>` prompt block is built from the marked region only, so the
 * editor never shows entries the user did not write nor lets them edit text the
 * model never reads.
 *
 * A malformed file (one marker without the other) renders as a refusal rather
 * than empty inputs: empty inputs invite a save, and that save is exactly the
 * write the server refuses.
 */

export function UserProfileSection({
  getUserProfile,
  setUserProfile,
}: UserProfileSectionProps): ReactElement {
  const [draft, setDraft] = useState<WebuiUserProfileFields>();
  const [baseline, setBaseline] = useState<WebuiUserProfileFields>();
  const [maxChars, setMaxChars] = useState(10 * 1024);
  const [malformed, setMalformed] = useState(false);
  const [filePath, setFilePath] = useState("");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string>();

  useEffect(() => {
    if (!getUserProfile) return;
    let cancelled = false;
    void getUserProfile()
      .then((value) => {
        if (cancelled || !value) return;
        const fields = pickProfileFields(value);
        setDraft(fields);
        setBaseline(fields);
        setMaxChars(value.maxChars);
        setMalformed(value.malformed);
        setFilePath(value.path);
      })
      .catch((cause: unknown) => {
        if (cancelled) return;
        setError(cause instanceof Error ? cause.message : String(cause));
      });
    return () => {
      cancelled = true;
    };
  }, [getUserProfile]);

  // Counted across all three fields, because that is what the server checks:
  // the write is capped on the composed file, so a `moreAbout` alone can cross
  // the budget while the two short fields stay far below it.
  const length =
    (draft?.nickname.length ?? 0) +
    (draft?.occupation.length ?? 0) +
    (draft?.moreAbout.length ?? 0);
  const overLimit = length > maxChars;
  // Three states: disabled while the fields still match
  // what the server returned, live once one of them differs, and live again
  // after a save because the returned view *is* the new baseline. Without the
  // dirty check the button is clickable on open, and a save that rewrites the
  // file byte-for-byte is a write the user never asked for. Only `moreAbout` is
  // editable, so the other two always compare equal — they are kept in the
  // comparison because the file layer still round-trips them.
  const saveable = isProfileSaveable(draft, baseline, {
    malformed,
    overLimit,
    canWrite: Boolean(setUserProfile),
  });

  const update = useCallback(
    (field: keyof WebuiUserProfileFields, value: string) => {
      setDraft((current) => (current ? { ...current, [field]: value } : current));
      setSaved(false);
    },
    [],
  );

  const save = useCallback(async () => {
    if (!setUserProfile || saving || draft === undefined || malformed) return;
    setSaving(true);
    setError(undefined);
    try {
      const next = await setUserProfile(draft);
      if (next) {
        // The server's answer is the new baseline, including whatever it
        // normalised: re-reading it is what makes the button go quiet again
        // after a save instead of staying live on a file that already matches.
        const fields = pickProfileFields(next);
        setDraft(fields);
        setBaseline(fields);
        setMaxChars(next.maxChars);
        setMalformed(next.malformed);
        setFilePath(next.path);
      }
      setSaved(true);
    } catch (cause: unknown) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSaving(false);
    }
  }, [draft, malformed, saving, setUserProfile]);

  const disabled = malformed || draft === undefined;

  return (
    <SettingsSection
      title="关于你"
      testId="user-profile-section"
      hint={PERSONALIZATION_SECTION_HINTS.userProfile}
      hintTestId="user-profile-hint"
      actions={
        <SettingsButton
          variant="black"
          className="webui-section-save-button"
          testId="user-profile-save"
          disabled={!saveable || saving}
          onClick={() => void save()}
        >
          保存
        </SettingsButton>
      }
    >
      <div className="webui-user-profile-fields">
        {/* One control, not three. The section
           renders a single TextArea bound to `moreAbout` — the `nickname` and
           `occupation` keys exist only in the *file* layer, where the reader
           and the writer still parse and re-emit their `Nickname: ` /
           `Occupation: ` lines so an existing profile is not truncated on the
           next save. Rendering inputs for them produced two permanently empty
           boxes above the real field, which is what they showed: the user's
           own `user.md` has both labels with nothing after the colon. */}
        <WebuiTextarea
          aria-label="更多关于你"
          data-testid="user-profile-more-about"
          controlSize="document"
          appearance="document"
          value={draft?.moreAbout ?? ""}
          spellCheck={false}
          placeholder={PROFILE_PLACEHOLDER}
          disabled={disabled}
          onChange={(event) => update("moreAbout", event.target.value)}
        />
      </div>
      <WebuiInline gap="medium" justify="between" className="webui-personalization-meta">
        <span data-testid="user-profile-path">{filePath}</span>
        <span
          data-testid="user-profile-size"
          className={overLimit ? "is-over-limit" : undefined}
        >
          {length} / {maxChars} 字符
        </span>
      </WebuiInline>
      {overLimit ? (
        <FeedbackError message="超过 {maxChars} 字符后，超出部分不会注入提示，请精简后再保存。" className="webui-settings-error" testId="user-profile-over-limit" />
      ) : null}
      {malformed ? (
        <FeedbackError message="user.md 的标记不完整，为避免覆盖记忆中已收集的内容，这里不做写入。" className="webui-settings-error" testId="user-profile-malformed" />
      ) : null}
      {error ? (
        <FeedbackError message=<>error</> className="webui-settings-error" testId="user-profile-error" />
      ) : null}
      {saved && !saving ? (
        <SettingsSavedNotice message="已保存" testId="user-profile-saved" />
      ) : null}
      {!getUserProfile || !setUserProfile ? (
        <p data-testid="user-profile-unavailable" className="webui-settings-error">
          当前运行时不支持「关于你」读写。
        </p>
      ) : null}
    </SettingsSection>
  );
}
