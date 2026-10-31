// The personalization page's composition and the four modules' lifecycle conditions.
//
// The page is asserted to compose, not to own: the three sections render together
// and unconditionally, and **no editor state lives in the page** — which is what
// makes each editor's load/edit/save/error lifecycle its own, and what the four
// failure behaviours below hang off.
//
// Source assertions on purpose: the interactions need a DOM and this package has no DOM test
// framework. Each names the exact expression, so moving the state up into the page, gating a section,
// or clearing a draft in a `catch` turns a case red.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const DIR = new URL("../../src/client/features/settings/ui/", import.meta.url);
const read = (name: string): string => readFileSync(fileURLToPath(new URL(name, DIR)), "utf8");

const page = read("PersonalizationSettings.tsx");
const sections = {
  GlobalInstructionsSection: read("GlobalInstructionsSection.tsx"),
  UserProfileSection: read("UserProfileSection.tsx"),
  MemorySection: read("MemorySection.tsx"),
};
const dialog = read("MemoryManagerDialog.tsx");

const slice = (text: string, from: string, to: string): string => {
  const start = text.indexOf(from);
  const end = text.indexOf(to, start);
  return end === -1 ? text.slice(start) : text.slice(start, end);
};

describe("the page composes and does not own", () => {
  it("renders all three editors, co-visible and unconditional", () => {
    for (const name of Object.keys(sections)) {
      expect(page, `page does not render ${name}`).toContain(`<${name}`);
    }
    // Co-visibility is the point: a section behind a condition would unmount, and
    // its draft would go with it.
    const body = page.slice(page.indexOf("return ("));
    expect(body).not.toMatch(/\{[^{}]*\?\s*<(?:GlobalInstructions|UserProfile|Memory)Section/u);
  });

  it("keeps every editor's state out of the page", () => {
    // The page reads the settings snapshot and hands the same callback shape down; the drafts,
    // baselines and busy flags belong to the sections.
    const stateNames = [...page.matchAll(/const \[(\w+), \w+\] = useState/gu)].map((m) => m[1]!);
    expect(stateNames).toEqual([]);
  });
});

describe("each editor keeps its own load/save lifecycle", () => {
  for (const [name, source] of Object.entries(sections)) {
    it(`${name} loads, saves, and reports its own failure`, () => {
      expect(source).toMatch(/const \[\w+, set\w+\] = useState/u);
      expect(source).toContain("useEffect(");
      expect(source).toMatch(/catch \(cause/u);
    });

    it(`${name} keeps the draft when a save fails`, () => {
      // A failed save must not discard what the user wrote. The catch records the message and
      // touches nothing else; `setSaved(true)` only ever runs on the success path.
      const caught = source.slice(source.indexOf("catch (cause"));
      const body = caught.slice(0, caught.indexOf("finally"));
      expect(body).not.toContain("setDraft(");
      expect(body).not.toContain("setBaseline(");
      expect(body).not.toContain("setSaved(true)");
    });
  }
});

describe("the manager dialog keeps its own mount and dismissal", () => {
  it("is mounted by the memory card under the same conditional", () => {
    expect(sections.MemorySection).toContain("const [managing, setManaging] = useState(false);");
    expect(sections.MemorySection).toContain("{managing ? (");
    expect(sections.MemorySection).toContain("<MemoryManagerDialog");
  });

  it("hears Escape on the document, sheds one layer at a time, and restores focus", () => {
    // Escape belongs to the shared dialog layer, not to this component: the
    // dialog registers itself and the coordinator sheds exactly the topmost
    // layer. A second handler here would close two layers on one press.
    expect(dialog).toContain("useDialogLayer({");
    // Two layers above the editor: the delete confirmation is the topmost, and Escape inside it must
    // dismiss that rather than the whole manager.
    expect(dialog).toContain("const confirmOpenRef = useRef(false);");
    expect(dialog).toContain("confirmOpenRef.current = confirmingDelete;");
    // Focus moves in on mount and back to whatever held it on unmount.
    expect(dialog).toContain("surfaceRef.current?.focus();");
    expect(dialog).toContain("restoreTo?.focus();");
  });

  it("still confirms a delete before it drops the file", () => {
    expect(dialog).toContain("const [confirmingDelete, setConfirmingDelete] = useState(false);");
    expect(dialog).toContain("MEMORY_DELETE_CONFIRM.title");
    // The removal writes an empty body — the dialog's own delete path, not the card's.
    const remove = slice(dialog, "const remove = useCallback(", "}, [saving, setAgentMemory]);");
    expect(remove).toContain('await setAgentMemory({ content: "" });');
  });

  it("keeps the file when a delete fails", () => {
    const remove = slice(dialog, "const remove = useCallback(", "}, [saving, setAgentMemory]);");
    const caught = remove.slice(remove.indexOf("catch (cause"));
    expect(caught).toContain("setError(");
    expect(caught).not.toContain('setBaseline("")');
    expect(caught).not.toContain("setDraft(");
  });
});
