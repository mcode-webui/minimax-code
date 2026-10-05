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
  PersonalizationSettings,
  resolveEditorSeed,
} from "../../src/client/components/settings/PersonalizationSettings.js";

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

  it("keeps save disabled before anything is loaded", () => {
    const markup = renderToStaticMarkup(
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
