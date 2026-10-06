// Personalization panel: the editor is a mirror of a server-owned file.
//
// The panel is the only WebUI surface that lets a user type into the
// profile-wide `AGENTS.md`. Three things there can silently lose or corrupt a
// user's text, and this file pins the two that are pure decisions:
//
//   1. The size cap belongs to the runtime. The panel renders `maxBytes` from
//      the server instead of re-declaring 32KiB, because a client copy drifts
//      the moment the runtime cap changes — and the drift surfaces as the
//      server rejecting a save the UI called valid.
//   2. A draft left in `localStorage` by the pre-AGENTS.md prototype must reach
//      the user instead of vanishing, but only when the profile file is
//      genuinely absent. Seeding it over a live AGENTS.md would resurrect text
//      the user has already replaced on disk, and the migration must not run
//      twice.
//
// The interactive half (load → edit → save) needs a DOM and an effect flush.
// This package has no DOM framework (`environment: "node"`, no jsdom), so that
// half is covered by the browser suite and by
// `global-instructions-operation.test.ts`, which exercises the real
// `GlobalInstructions` against a temp data dir. What is asserted below is the
// decision the component makes, plus that it declines to fake support.

import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import {
  MEMORY_DELETE_CONFIRM,
  MEMORY_HANDOFF_PROMPT,
  PERSONALIZATION_SECTION_HINTS,
  MemoryManagerDialog,
  PersonalizationSettings,
  formatMemoryTimestamp,
  isMemorySaveable,
  isProfileSaveable,
  resolveEditorSeed,
} from "../../src/client/components/settings/PersonalizationSettings.js";

describe("记忆摘要 save button states", () => {
  it("stays disabled until the text actually changes", () => {
    // The desktop's predicate, lifted so it can be tested without an effect
    // flush: `!loading && !saving && draft !== baseline && draft.length > 0`.
    // This is what was missing -- the button was live the moment the dialog
    // opened, offering a write that rewrites the file byte-for-byte.
    const base = { draft: "# hello", baseline: "# hello", loading: false, saving: false };
    expect(isMemorySaveable(base)).toBe(false);

    // An edit turns it on.
    expect(isMemorySaveable({ ...base, draft: "# hello\n" })).toBe(true);
    // So does the state right after a load lands: the server's text is the
    // baseline, so an untouched file is not a pending write.
    expect(isMemorySaveable({ ...base, draft: undefined })).toBe(false);
    // An emptied editor is a delete, and that lives behind the ⋯ menu.
    expect(isMemorySaveable({ ...base, draft: "" })).toBe(false);
    // Neither in-flight state may be clickable.
    expect(isMemorySaveable({ ...base, draft: "x", loading: true })).toBe(false);
    expect(isMemorySaveable({ ...base, draft: "x", saving: true })).toBe(false);
  });

  it("renders the save button disabled on open", () => {
    // The half of the wiring a static render can see. `draft` is undefined
    // until the first read lands, so the button must already be disabled in
    // this frame -- it is the frame the user sees before any load resolves.
    //
    // What this cannot catch: swapping the predicate at the call site for a
    // laxer one. `renderToStaticMarkup` runs no effects, so no test here can
    // drive the button into its enabled state; the predicate itself is covered
    // above, the one-line wiring is not independently testable.
    const markup = renderToStaticMarkup(
      <MemoryManagerDialog onClose={() => {}} />,
    );
    const save = markup.slice(markup.indexOf('data-testid="agent-memory-save"'));
    expect(save.slice(0, save.indexOf(">"))).toContain("disabled");
  });
});

describe("记忆摘要 dialog markup", () => {
  it("pairs a grey 取消 with a black 保存, as the desktop does", () => {
    // The desktop's last row is `flex justify-between` with the timestamp on the
    // left; the two buttons are `variant:"gray"` for 取消 and `variant:"black"`
    // for 保存. Drawing both grey made the committing action the quieter of the
    // two, which is the opposite of the intent.
    const markup = renderToStaticMarkup(
      <MemoryManagerDialog onClose={() => {}} />,
    );

    const footer = markup.slice(markup.indexOf("webui-memory-manager-footer"));
    expect(footer).toContain('data-testid="agent-memory-save"');
    expect(footer).toContain("webui-mavis-button-black");
    // 取消 keeps the light fill it is given.
    expect(footer).toContain("webui-mavis-button-gray");
    expect(footer).not.toContain(
      "webui-mavis-button-gray webui-mavis-button-gray",
    );
  });

  it("keeps the timestamp in the footer row, below the editor", () => {
    // The desktop's order is: editor, then one `justify-between` row holding the
    // timestamp on the left and 取消/保存 on the right. The editor itself is not
    // asserted here -- `draft` only exists after the first read, and
    // `renderToStaticMarkup` runs no effects, so the count row never paints in
    // this render. Its geometry is covered in `webui-w0-css-structure.test.ts`.
    const markup = renderToStaticMarkup(
      <MemoryManagerDialog onClose={() => {}} />,
    );
    expect(markup).toContain('class="webui-memory-manager-footer"');
    expect(markup).toContain('data-testid="agent-memory-updated"');
    expect(markup.indexOf("webui-memory-manager-footer")).toBeGreaterThan(
      markup.indexOf('data-testid="agent-memory-manage'),
    );
  });
});

describe("「在会话中创建」 hand-off", () => {
  it("leaves the line the desktop's composer already has typed", () => {
    // Read off the desktop screenshot, not invented: it is the whole text the
    // user finds waiting, and the attachment chip carries the file identity.
    expect(MEMORY_HANDOFF_PROMPT).toBe("我想调整下这个记忆文件");
  });
});

describe("the delete confirmation's copy", () => {
  it("matches the desktop's modal word for word", () => {
    // Transcribed from the desktop modal after zooming it: the title ends on a
    // half-width `?` (a full-width one carries a full em of advance and opens a
    // visible gap), the body's comma and full stop are full-width, and there is
    // no byte count in the body — the row above the button already shows one.
    expect(MEMORY_DELETE_CONFIRM).toEqual({
      title: "删除记忆?",
      body: "MiniMax Code 将不再记住关于你的重要信息，你的使用体验将少一些个性化。",
      cancel: "取消",
      confirm: "删除",
    });
  });

  it("does not smuggle a byte count back into the body", () => {
    // The WebUI's earlier confirmation opened with "将删除 112 KB 的长期记忆
    // 文件". The desktop says nothing of the kind, and a paraphrase here is the
    // whole thing this suite exists to prevent.
    expect(MEMORY_DELETE_CONFIRM.body).not.toMatch(/KB|字节/);
    expect(MEMORY_DELETE_CONFIRM.title).not.toMatch(/KB|字节/);
  });
});

describe("formatMemoryTimestamp", () => {
  // The desktop footer reads `更新于 2026-10-06 04:48:48`. Hand-rolled rather
  // than `toLocaleString`, so these assertions are the thing that keeps the
  // shape from quietly following the host locale.
  it("renders the stamp in the desktop's own shape", () => {
    const stamp = formatMemoryTimestamp(new Date(2026, 9, 6, 4, 48, 48).toISOString());
    expect(stamp).toMatch(/^更新于 2026-10-06 \d{2}:\d{2}:\d{2}$/u);
  });

  it("zero-pads the single-digit parts", () => {
    const stamp = formatMemoryTimestamp(new Date(2026, 0, 2, 3, 4, 5).toISOString());
    expect(stamp).toBe("更新于 2026-01-02 03:04:05");
  });

  it("says nothing rather than printing Invalid Date", () => {
    // A missing stamp is a file the server could not stat, and an unparseable
    // one is a contract that drifted. Neither should reach the footer as text.
    expect(formatMemoryTimestamp(undefined)).toBe("");
    expect(formatMemoryTimestamp("not-a-date")).toBe("");
  });
});

describe("resolveEditorSeed", () => {
  it("prefers the live profile file over a stale browser-local draft", () => {
    expect(
      resolveEditorSeed({
        exists: true,
        content: "# 现网内容\n",
        legacyDraft: "# 旧草稿\n",
        migrationDone: false,
      }),
    ).toBe("# 现网内容\n");
  });

  it("adopts the legacy draft when the profile file does not exist yet", () => {
    expect(
      resolveEditorSeed({
        exists: false,
        content: "",
        legacyDraft: "# 旧草稿\n",
        migrationDone: false,
      }),
    ).toBe("# 旧草稿\n");
  });

  it("opens empty when there is neither a file nor a draft", () => {
    expect(
      resolveEditorSeed({ exists: false, content: "", legacyDraft: "   ", migrationDone: false }),
    ).toBe("");
  });

  // The flag is set by the first successful load, so a second visit must not
  // re-seed a draft the user already declined to save.
  it("does not re-adopt the draft after the migration has run", () => {
    expect(
      resolveEditorSeed({
        exists: false,
        content: "",
        legacyDraft: "# 旧草稿\n",
        migrationDone: true,
      }),
    ).toBe("");
  });

  it("still shows the file content after the migration has run", () => {
    expect(
      resolveEditorSeed({
        exists: true,
        content: "# 现网内容\n",
        legacyDraft: "# 旧草稿\n",
        migrationDone: true,
      }),
    ).toBe("# 现网内容\n");
  });
});

describe("PersonalizationSettings markup", () => {
  it("declares an unavailable surface instead of a silently dead editor", () => {
    const markup = renderToStaticMarkup(<PersonalizationSettings />);

    expect(markup).toContain("webui-personalization-textarea");
    expect(markup).toContain("global-instructions-unavailable");
  });

  it("labels the editor for the global instructions and shows the byte budget", () => {
    const markup = renderToStaticMarkup(<PersonalizationSettings />);

    expect(markup).toContain("自定义指令");
    // The default cap before the first read resolves. The authoritative value
    // arrives from the server; this is only the pre-read placeholder.
    expect(markup).toContain(`${32 * 1024}`);
    expect(markup).toContain("字节");
  });

  it("shows no file size on the 记忆摘要 row, matching the desktop", () => {
    const markup = renderToStaticMarkup(
      <PersonalizationSettings
        getAgentMemory={() => Promise.resolve({
          content: "lesson",
          exists: true,
          path: "/tmp/MEMORY.md",
          sizeBytes: 123_240,
          updatedAt: "2026-10-06T04:48:48.000Z",
        })}
        setAgentMemory={() => Promise.resolve({
          content: "",
          exists: false,
          path: "/tmp/MEMORY.md",
          sizeBytes: 0,
        })}
      />,
    );

    // The desktop row carries the title, the description and 管理 — nothing
    // between them. A byte count here was a second, differently-scaled reading
    // of the same file (the manager shows characters), and it is also the
    // reason opening the pane used to fetch the whole memory document.
    expect(markup).toContain("记忆摘要");
    expect(markup).toContain("管理");
    expect(markup).not.toContain("123240");
    expect(markup).not.toContain("memory-summary-size");
  });

  it("does not read the memory document just to render the settings pane", () => {
    const calls: string[] = [];
    renderToStaticMarkup(
      <PersonalizationSettings
        getAgentMemory={() => {
          calls.push("getAgentMemory");
          return Promise.resolve({
            content: "",
            exists: false,
            path: "/tmp/MEMORY.md",
            sizeBytes: 0,
          });
        }}
        setAgentMemory={() => Promise.resolve({
          content: "",
          exists: false,
          path: "/tmp/MEMORY.md",
          sizeBytes: 0,
        })}
      />,
    );

    // The manager loads the content when 管理 is pressed, not before.
    expect(calls).toEqual([]);
  });

  it("keeps save disabled before anything is loaded", () => {    const markup = renderToStaticMarkup(
      <PersonalizationSettings
        getGlobalInstructions={() => Promise.resolve({
          content: "",
          exists: false,
          path: "/tmp/AGENTS.md",
          maxBytes: 32 * 1024,
        })}
        setGlobalInstructions={() => Promise.resolve({
          content: "",
          exists: false,
          path: "/tmp/AGENTS.md",
          maxBytes: 32 * 1024,
        })}
      />,
    );

    // `dirty` is false until a read resolves, so the first paint cannot offer
    // a save that would write an empty file over the user's AGENTS.md.
    expect(markup).toMatch(/<button[^>]*data-testid="global-instructions-save"[^>]*disabled=""/u);
  });
});

describe("记忆 section markup", () => {
  it("presents the three desktop rows rather than one textarea", () => {
    const markup = renderToStaticMarkup(<PersonalizationSettings />);

    expect(markup).toContain("记忆");
    expect(markup).toContain("主动记忆");
    expect(markup).toContain("记忆摘要");
    // "管理" is the row that actually points at a manager. The roadmap's
    // "管理 UI 未见" only closes once that entry point exists, so its absence
    // has to fail here rather than pass as a tidier layout.
    expect(markup).toContain("管理");
    expect(markup).toContain("agent-memory-load");
  });

  it("renders no memory body until 管理 is pressed", () => {
    const markup = renderToStaticMarkup(<PersonalizationSettings />);

    // The dialog loads its own body on open, so the panel's first paint still
    // has to stay free of the editor: a live main file is ~115KB and shipping
    // it with the panel would make the tab slow to open for a row that only
    // needed the size.
    expect(markup).not.toContain("agent-memory-manager");
    expect(markup).not.toContain("agent-memory-textarea");
  });

  it("declines to open a manager it cannot save through", () => {
    const markup = renderToStaticMarkup(
      <PersonalizationSettings
        getAgentMemory={() => Promise.resolve({
          agentName: "mavis",
          path: "/tmp/agents/mavis/memory/MEMORY.md",
          exists: false,
          sizeBytes: 0,
        })}
      />,
    );

    // A read-only manager would open a body the user could not change, so the
    // entry point stays out of reach rather than leading somewhere useless.
    expect(markup).toMatch(/<button[^>]*data-testid="agent-memory-load"[^>]*disabled=""/u);
  });

  it("declines the memory surface instead of faking it when the transport is absent", () => {
    const markup = renderToStaticMarkup(<PersonalizationSettings />);

    expect(markup).toContain("agent-memory-unavailable");
    expect(markup).toMatch(/<button[^>]*data-testid="agent-memory-load"[^>]*disabled=""/u);
  });

  it("declines the switches when the configuration capability is absent", () => {
    const markup = renderToStaticMarkup(<PersonalizationSettings />);

    expect(markup).toContain("memory-settings-unavailable");
    expect(markup).toMatch(/<button[^>]*data-testid="memory-enabled-switch"[^>]*disabled=""/u);
    expect(markup).toMatch(/<button[^>]*data-testid="memory-proactive-switch"[^>]*disabled=""/u);
  });

  it("keeps the switches out of reach until a read gives them a baseline", () => {
    const markup = renderToStaticMarkup(<PersonalizationSettings />);

    // Not merely rendered off — unreachable. A switch showing an unknown
    // state that still accepts a click is how a setting gets flipped by
    // accident: the user cannot see what they are changing, and the write
    // lands on top of a state nobody read.
    expect(markup).toMatch(/<button[^>]*data-testid="memory-enabled-switch"[^>]*disabled=""/u);
    expect(markup).toMatch(/<button[^>]*data-testid="memory-proactive-switch"[^>]*disabled=""/u);
  });

  it("renders both switches off before any read resolves", () => {
    const markup = renderToStaticMarkup(<PersonalizationSettings />);

    // Unknown is rendered as off, not as on. Showing the documented default
    // would be a guess about a read that has not happened yet. The two
    // attributes are matched in the order React emits them, but only within
    // one tag: the assertion is about the switch, not about the markup order.
    expect(markup).toMatch(/<button[^>]*aria-checked="false"[^>]*data-testid="memory-enabled-switch"/u);
    expect(markup).toMatch(/<button[^>]*aria-checked="false"[^>]*data-testid="memory-proactive-switch"/u);
  });
});

describe("关于你 section markup", () => {
  it("declares an unavailable surface instead of a dead editor", () => {
    const markup = renderToStaticMarkup(<PersonalizationSettings />);

    expect(markup).toContain("关于你");
    expect(markup).toContain("user-profile-more-about");
    expect(markup).toContain("user-profile-unavailable");
  });

  it("renders exactly one control, bound to moreAbout", () => {
    const markup = renderToStaticMarkup(<PersonalizationSettings />);

    // The desktop's `personalization-profile-section` renders a single TextArea
    // bound to `moreAbout`. `nickname` and `occupation` live only in the file
    // layer — the reader and the writer still handle their `Nickname: ` /
    // `Occupation: ` lines — and the desktop draws no control for either.
    //
    // Rendering inputs for them put two permanently empty boxes above the one
    // editable field: a profile that never filled them in showed as a pair of
    // blank rectangles, which read as a broken form rather than as an empty one.
    expect(markup).toContain('data-testid="user-profile-more-about"');
    expect(markup).not.toContain('data-testid="user-profile-nickname"');
    expect(markup).not.toContain('data-testid="user-profile-occupation"');
    // The old single-textarea editor is gone with the model it belonged to.
    expect(markup).not.toContain("user-profile-textarea");
    // Exactly one control inside the section. Scoped by offset rather than by a
    // page-wide count: `webui-personalization-meta` is a shared class that the
    // 自定义指令 section above also renders, so the first match is not this
    // section's.
    const start = markup.indexOf('class="webui-user-profile-fields"');
    expect(start).toBeGreaterThan(-1);
    const end = markup.indexOf("webui-personalization-meta", start);
    expect(end).toBeGreaterThan(start);
    const fields = markup.slice(start, end);
    expect([...fields.matchAll(/<textarea\b/gu)]).toHaveLength(1);
    expect(fields).not.toContain("<input");
  });

  it("names the control for assistive tech without a label column", () => {
    const markup = renderToStaticMarkup(<PersonalizationSettings />);

    expect(markup).toContain('aria-label="更多关于你"');
    expect(markup).not.toContain("<span>昵称</span>");
    expect(markup).not.toContain("<span>职业</span>");
    // The desktop's own placeholder is the i18n key
    // `settings.personalization_more_about_placeholder`; ours is the Chinese
    // rendering of it. Asserted so the field is never left unlabelled.
    expect(markup).toContain("placeholder=");
    // No per-field wrapper either: the control is a direct child of the column,
    // which is what lets it span the card's full width.
    expect(markup).toContain('class="webui-user-profile-fields"');
    expect(markup).not.toContain("<label");
  });

  it("keeps the section save disabled until a field actually changes", () => {
    // The desktop has three states: disabled while the fields still match what
    // the server returned, live once one differs, and quiet again after a save
    // because the server's own answer becomes the new baseline.
    //
    // `renderToStaticMarkup` cannot see this: it paints one frame and never
    // resolves the read, so the button is disabled for the pre-load reason
    // whatever this logic says. Hence the predicate below is tested directly.
    const base = { nickname: "izzy", occupation: "engineer", moreAbout: "note" };
    const ok = { malformed: false, overLimit: false, canWrite: true };

    expect(isProfileSaveable(base, base, ok)).toBe(false);
    expect(isProfileSaveable({ ...base, nickname: "izzy2" }, base, ok)).toBe(true);
    expect(isProfileSaveable({ ...base, occupation: "designer" }, base, ok)).toBe(true);
    expect(isProfileSaveable({ ...base, moreAbout: "other" }, base, ok)).toBe(true);
    // Clearing a field is a change like any other.
    expect(isProfileSaveable({ ...base, moreAbout: "" }, base, ok)).toBe(true);
  });

  it("keeps the save disabled when the form is not the obstacle", () => {
    const base = { nickname: "a", occupation: "b", moreAbout: "c" };
    const changed = { ...base, nickname: "changed" };

    // A save already in flight, a half-marked file, an over-cap draft, and a
    // host that cannot write all keep the button dead regardless of the dirty
    // check.
    expect(isProfileSaveable(changed, base, { malformed: true, overLimit: false, canWrite: true })).toBe(false);
    expect(isProfileSaveable(changed, base, { malformed: false, overLimit: true, canWrite: true })).toBe(false);
    expect(isProfileSaveable(changed, base, { malformed: false, overLimit: false, canWrite: false })).toBe(false);
    // No read has landed yet.
    expect(isProfileSaveable(changed, undefined, { malformed: false, overLimit: false, canWrite: true })).toBe(false);
  });

  it("renders the save button with the state class the CSS hangs off", () => {
    const markup = renderToStaticMarkup(<PersonalizationSettings />);

    expect(markup).toContain("webui-section-save-button");
    expect(markup).toContain('data-testid="user-profile-save"');
    // The variant class decides the whole look — filled primary vs light fill —
    // so it is pinned here and not only in the stylesheet test. Both section
    // headers pass `variant: "black"` in the desktop bundle.
    expect(markup).toContain("webui-mavis-button-black");
    expect(markup).not.toContain("webui-mavis-button-gray webui-section-save-button");
  });

  it("shows an untouched region as three empty fields, not as its own text", () => {
    const markup = renderToStaticMarkup(
      <PersonalizationSettings
        getUserProfile={() =>
          Promise.resolve({
            nickname: "",
            occupation: "",
            moreAbout: "",
            exists: true,
            malformed: false,
            path: "/tmp/user.md",
            sizeBytes: 180,
            maxChars: 10 * 1024,
          })
        }
        setUserProfile={() => Promise.resolve({
          nickname: "",
          occupation: "",
          moreAbout: "",
          exists: true,
          malformed: false,
          path: "/tmp/user.md",
          sizeBytes: 180,
          maxChars: 10 * 1024,
        })}
      />,
    );

    // The first paint is the pre-read state, so the fields render empty. The
    // labels are present but no value is: `Nickname: ` with nothing after the
    // colon is an empty field, not a line of text the user wrote.
    expect(markup).not.toContain("Nickname: ");
    expect(markup).not.toContain("# User profile");
  });

  it("uses the desktop placeholder so the field reads as a profile, not a file", () => {
    const markup = renderToStaticMarkup(<PersonalizationSettings />);

    expect(markup).toContain("告诉 Agent 你的背景和长期偏好");
  });

  it("keeps save out of reach until a read resolves", () => {
    const markup = renderToStaticMarkup(<PersonalizationSettings />);

    // An unresolved read must not offer a save: the draft is empty, and
    // writing it would clear a profile the user never opened.
    expect(markup).toMatch(/<button[^>]*data-testid="user-profile-save"[^>]*disabled=""/u);
  });

  it("refuses to write a half-marked profile", () => {
    const markup = renderToStaticMarkup(
      <PersonalizationSettings
        getUserProfile={() => Promise.resolve({
          content: "",
          exists: false,
          malformed: true,
          path: "/tmp/memory/user.md",
          sizeBytes: 42,
          maxChars: 10 * 1024,
        })}
        setUserProfile={() => Promise.resolve({
          content: "",
          exists: false,
          malformed: true,
          path: "/tmp/memory/user.md",
          sizeBytes: 42,
          maxChars: 10 * 1024,
        })}
      />,
    );

    // The static markup cannot show resolved state, so this pins that the
    // refusal exists in the tree at all; the behavioural half of this rule is
    // covered by `writeUserProfile` refusing the write in `profile-files.test.ts`.
    expect(markup).toContain("user-profile-section");
  });
});

describe("section hints", () => {
  it("gives every section an accessible help affordance", () => {
    const markup = renderToStaticMarkup(<PersonalizationSettings />);

    for (const testId of [
      "global-instructions-hint",
      "user-profile-hint",
      "memory-hint",
    ]) {
      expect(markup).toContain(testId);
    }
  });

  // A real bubble replaced a native `title` on this control. Three things had
  // to be true at the same time, and each is separately breakable: the glyph
  // has to stay keyboard-reachable (a `role="img"` span is not), the visible
  // sentence has to be the same one the name announces (two literals drift),
  // and no `title` may come back (the browser's own bubble would paint on top
  // of ours, about a second late, with no arrow).
  it("renders each hint as a focusable control whose bubble repeats its name", () => {
    const markup = renderToStaticMarkup(<PersonalizationSettings />);

    expect(markup).toContain("webui-settings-info-hint-bubble");
    // The old affordance, if either half of it returns, fails here.
    expect(markup).not.toContain('role="img"');
    expect(markup).not.toMatch(/<[^>]*\stitle=/u);

    for (const hint of Object.values(PERSONALIZATION_SECTION_HINTS)) {
      // Once as the control's accessible name, once as the visible sentence.
      expect(markup.split(`aria-label="${hint}"`)).toHaveLength(2);
      expect(markup).toContain(`>${hint}</span>`);
    }
  });

  it("carries the desktop's own wording for all three sections", () => {
    // The previous strings described the mechanism instead of the effect
    // ("注入每个会话的 <user_profile>…"), which is a note to whoever debugs
    // the injection rather than a line that tells a user what the field is
    // for. These three are copied from the desktop bubbles character for
    // character, so the two surfaces cannot drift on the same control.
    expect(Object.values(PERSONALIZATION_SECTION_HINTS)).toEqual([
      "定义 Agent 应该如何工作、回答和执行任务，为此设备上的所有 Agent 提供额外指令和上下文。",
      "告诉 Agent 你的背景和长期偏好。",
      "设置在此电脑上如何收集、保留和整合本地记忆。",
    ]);
  });
});
