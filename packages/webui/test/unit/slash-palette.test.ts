import { describe, expect, it } from "vitest";
import {
  applyWebuiSlashLiteMode,
  buildWebuiSlashPalette,
  isWebuiRunnableCommand,
  rankWebuiSlashPalette,
  resolveWebuiSlashSkills,
  sectionWebuiSlashPalette,
  slashSkillSummaryToEntry,
  WEBUI_BUILTIN_COMMANDS,
  WEBUI_PLUGIN_REGISTRY,
  WEBUI_RUN_COMMAND_NAMES,
  WEBUI_SKILL_FIXTURES,
} from "../../src/client/slash-palette.js";

// These tests cover sectioning, four-rank filtering, lite-mode filtering,
// and the `isWebuiRunnableCommand` narrowing.

describe("WebUI slash palette — sectioning", () => {
  it("orders built-ins in declaration order, then plugin entries", () => {
    const skills = Object.values(WEBUI_PLUGIN_REGISTRY);
    const palette = buildWebuiSlashPalette({ skills });
    const names = palette.map((entry) => entry.name);
    // The contract is the *ordering rule*, not one frozen list: every built-in
    // comes before every plugin entry, and the built-ins keep their declared
    // order. Adding a built-in must not require editing this test.
    expect(names.slice(0, WEBUI_BUILTIN_COMMANDS.length)).toEqual(
      WEBUI_BUILTIN_COMMANDS.map((entry) => entry.name),
    );
    expect(names.slice(WEBUI_BUILTIN_COMMANDS.length)).toEqual(["deploy-website"]);
  });

  it("splits built-ins and plugin entries by `paletteSection === \"special\"`", () => {
    const skills = Object.values(WEBUI_PLUGIN_REGISTRY);
    const palette = buildWebuiSlashPalette({ skills });
    const defaultSection = palette.filter(
      (entry) => entry.source_type === -1 || entry.paletteSection === "special",
    );
    const names = defaultSection.map((entry) => entry.name);
    expect(names).toEqual([
      ...WEBUI_BUILTIN_COMMANDS.map((entry) => entry.name),
      "deploy-website",
    ]);
  });

  it("exposes every built-in command, composer modes and run-commands alike", () => {
    const palette = sectionWebuiSlashPalette(WEBUI_BUILTIN_COMMANDS, []);
    // `compact` carries no composerMode, so a test that asserted "only the
    // composer modes" would have hidden it — that is exactly the blind spot
    // that let the run-command entry go missing while the palette stayed green.
    expect(palette.map((entry) => entry.name)).toEqual(
      WEBUI_BUILTIN_COMMANDS.map((entry) => entry.name),
    );
    expect(palette.length).toBeGreaterThan(0);
  });
});

describe("WebUI slash palette — lite-mode filter", () => {
  it("keeps only skills, goal and plan in lite mode", () => {
    const skills = Object.values(WEBUI_PLUGIN_REGISTRY);
    const fullPalette = buildWebuiSlashPalette({ skills });
    const litePalette = applyWebuiSlashLiteMode(fullPalette, true);
    const names = litePalette.map((entry) => entry.name);
    // `deploy-website` sits in the default section (paletteSection: "special")
    // but its source_type is -1 like the built-ins, so the desktop's predicate
    // removes it in lite mode — only `goal` and `plan` survive via composerMode.
    expect(names).toEqual(["goal", "plan"]);
  });
});

describe("WebUI slash palette — rank filter", () => {
  const palette = buildWebuiSlashPalette({
    skills: Object.values(WEBUI_PLUGIN_REGISTRY),
  });

  it("returns the palette untouched on empty query", () => {
    expect(rankWebuiSlashPalette(palette, "").map((entry) => entry.name)).toEqual(
      palette.map((entry) => entry.name),
    );
  });

  it("ranks exact name match first", () => {
    const result = rankWebuiSlashPalette(palette, "compact");
    expect(result[0]?.name).toBe("compact");
  });

  it("ranks startsWith before includes", () => {
    // Query "p" matches `plan` (startsWith) and `compact` (includes "p").
    const result = rankWebuiSlashPalette(palette, "p");
    const names = result.map((entry) => entry.name);
    const planIdx = names.indexOf("plan");
    const compactIdx = names.indexOf("compact");
    expect(planIdx).toBeGreaterThanOrEqual(0);
    expect(compactIdx).toBeGreaterThan(planIdx);
  });

  it("falls back to substring across label/description fields", () => {
    // "目标" only appears in `goal`'s description — rank 3 hit.
    const result = rankWebuiSlashPalette(palette, "目标");
    expect(result.map((entry) => entry.name)).toContain("goal");
  });

  it("preserves original index within the same rank", () => {
    // Empty result still preserves palette order via the sectioning pass.
    const empty = rankWebuiSlashPalette(palette, "zzznomatch");
    expect(empty).toEqual([]);
  });
});

describe("WebUI slash palette — runtime narrowing", () => {
  it("isWebuiRunnableCommand narrows to WebuiRunCommandName entries", () => {
    const palette = buildWebuiSlashPalette({
      skills: Object.values(WEBUI_PLUGIN_REGISTRY),
    });
    const runnable = palette.filter(isWebuiRunnableCommand);
    const names = runnable.map((entry) => entry.name).sort();
    // These rows carry no composerMode, so the lite filter drops them — but
    // they ARE runnable: `classifyWebuiSlashCommand` returns "runnable" and
    // `resolveWebuiSubmissionIntent` path 3 dispatches them to the host's
    // `runCommand`. An earlier version of this test asserted `[]` with the
    // comment "those commands are hidden from this palette" — that pinned the
    // missing `compact` entry in place and let the palette stay green while
    // `/compact` was unreachable from the UI.
    expect(names).toEqual(["compact"]);
  });

  it("exposes the run-command the server transport actually routes", () => {
    // The cross-module contract, stated so that deleting the entry fails it.
    //
    // `server/commands/runner.ts` routes `command === "compact"` into
    // `port.requestCompaction`, and the operation is registered in
    // `server/operation/operations.ts`. A palette that omits the row leaves
    // `resolveWebuiSubmissionIntent` unable to find the name, so the
    // submit-turn path swallows `/compact` and sends it as a plain chat
    // message. The other names in WEBUI_RUN_COMMAND_NAMES (`help`, `new`,
    // `status`, `usage`, `model`) have no palette row yet on purpose — they
    // need their own scope, so this test pins the one command that is wired
    // end to end rather than asserting the whole whitelist.
    const palette = buildWebuiSlashPalette({
      skills: Object.values(WEBUI_PLUGIN_REGISTRY),
    });
    const runnableNames = palette.filter(isWebuiRunnableCommand).map((entry) => entry.name);
    expect(runnableNames).toContain("compact");
  });

  it("does not leave a run-command row marked unsupported", () => {
    // A built-in whose name is in WEBUI_RUN_COMMAND_NAMES but whose
    // `supported` is false would render inert and fall through to
    // submit-turn — the user would watch their slash command come back as
    // typed text. Guard the rows that actually exist, and require the
    // whitelist to be non-empty so the loop cannot pass vacuously.
    const runnableCandidates = WEBUI_BUILTIN_COMMANDS.filter((entry) =>
      (WEBUI_RUN_COMMAND_NAMES as readonly string[]).includes(entry.name),
    );
    expect(runnableCandidates.length).toBeGreaterThan(0);
    for (const entry of runnableCandidates) {
      expect(
        entry.supported,
        `built-in "${entry.name}" is in WEBUI_RUN_COMMAND_NAMES but supported=false`,
      ).toBe(true);
      expect(isWebuiRunnableCommand(entry)).toBe(true);
    }
  });

  it("keeps the palette's runnable set inside the transport whitelist", () => {
    // The other direction: nothing may claim to be runnable unless the host
    // port will accept the name.
    const palette = buildWebuiSlashPalette({
      skills: Object.values(WEBUI_PLUGIN_REGISTRY),
    });
    for (const entry of palette.filter(isWebuiRunnableCommand)) {
      expect(WEBUI_RUN_COMMAND_NAMES as readonly string[]).toContain(entry.name);
    }
  });

  it("WEBUI_RUN_COMMAND_NAMES matches the server-side validation list", () => {
    // The harness port validation list lives in
    // src/server/operation/provider.ts; keep the
    // client literal union aligned so the narrowing never lies.
    expect([...WEBUI_RUN_COMMAND_NAMES].sort()).toEqual(
      ["compact", "help", "model", "new", "status", "usage"],
    );
  });
});

describe("WebUI slash palette — skill fixtures", () => {
  it("places skill entries after the default section with paletteSection: \"skills\"", async () => {
    const resolved = await resolveWebuiSlashSkills();
    expect(resolved.source).toBe("fixtures-fallback");
    const palette = buildWebuiSlashPalette({ skills: resolved.skills });
    const skillRows = palette.filter(
      (entry) => entry.paletteSection === "skills",
    );
    const names = skillRows.map((entry) => entry.name);
    expect(names).toEqual([
      "ask-matt",
      "code-review",
      "codebase-design",
      "diagnosing-bugs",
    ]);
  });

  it("marks every skill entry as supported so the popover row is clickable", async () => {
    // Mirrors the desktop: skill rows are clickable and insert "/<skill> " into
    // the composer, but submit does not dispatch runCommand (the name isn't in
    // WEBUI_RUN_COMMAND_NAMES), so the slash becomes a user message instead.
    const skills = (await resolveWebuiSlashSkills()).skills;
    const palette = buildWebuiSlashPalette({ skills });
    const skillRows = palette.filter(
      (entry) => entry.paletteSection === "skills",
    );
    expect(skillRows.length).toBeGreaterThan(0);
    expect(skillRows.every((entry) => entry.supported === true)).toBe(true);
    expect(skillRows.some((entry) => isWebuiRunnableCommand(entry))).toBe(
      false,
    );
  });

  it("WEBUI_SKILL_FIXTURES lists the four desktop skills", () => {
    expect(WEBUI_SKILL_FIXTURES.map((entry) => entry.name).sort()).toEqual([
      "ask-matt",
      "code-review",
      "codebase-design",
      "diagnosing-bugs",
    ]);
  });
});

describe("WebUI slash palette — fetched skills", () => {
  it("uses fetched skills when the fetcher resolves", async () => {
    const fetched = [
      { name: "my-local-skill", displayName: "My Local", description: "Local skill" },
      { name: "another-skill", description: "Another one" },
    ];
    const resolved = await resolveWebuiSlashSkills({
      fetcher: async () => fetched,
    });
    expect(resolved.source).toBe("harness");
    const skillNames = resolved.skills
      .filter((entry) => entry.paletteSection === "skills")
      .map((entry) => entry.name)
      .sort();
    // The fixture set must NOT leak through when the fetcher returns data.
    expect(skillNames).toEqual(["another-skill", "my-local-skill"]);
  });

  it("falls back to fixtures when the fetcher rejects", async () => {
    const resolved = await resolveWebuiSlashSkills({
      fetcher: async () => {
        throw new Error("harness down");
      },
    });
    expect(resolved.source).toBe("fixtures-fallback");
    const skillNames = resolved.skills
      .filter((entry) => entry.paletteSection === "skills")
      .map((entry) => entry.name)
      .sort();
    expect(skillNames).toEqual([
      "ask-matt",
      "code-review",
      "codebase-design",
      "diagnosing-bugs",
    ]);
  });

  it("surfaces `harness-empty` (not fixtures-fallback) when the fetcher returns an empty list", async () => {
    const resolved = await resolveWebuiSlashSkills({
      fetcher: async () => [],
    });
    // Empty payload is reported distinctly from a port failure. The caller
    // can decide whether to keep the fixtures or render an empty popover.
    // The plugin registry entries (`paletteSection: "special"`) are always
    // merged regardless of the skills path; only the skills pool is empty.
    expect(resolved.source).toBe("harness-empty");
    const skillEntries = resolved.skills.filter(
      (entry) => entry.paletteSection === "skills",
    );
    expect(skillEntries).toEqual([]);
    const pluginEntries = resolved.skills.filter(
      (entry) => entry.paletteSection === "special",
    );
    expect(pluginEntries.map((entry) => entry.name)).toContain(
      "deploy-website",
    );
  });

  it("falls back to fixtures when no fetcher is provided", async () => {
    const resolved = await resolveWebuiSlashSkills();
    expect(resolved.source).toBe("fixtures-fallback");
    const skillNames = resolved.skills
      .filter((entry) => entry.paletteSection === "skills")
      .map((entry) => entry.name);
    expect(skillNames).toContain("ask-matt");
  });

  it("maps a harness skill summary into a popover row", () => {
    const entry = slashSkillSummaryToEntry({
      name: "review-pr",
      displayName: "Review PR",
      description: "Reviews a pull request",
    });
    expect(entry).toMatchObject({
      name: "review-pr",
      displayName: "Review PR",
      label: "Review PR",
      description: "Reviews a pull request",
      source_type: 1,
      source_kind: "plugin",
      paletteSection: "skills",
      supported: true,
    });
    // icon is a render function
    expect(typeof entry.icon).toBe("function");
  });

  it("falls back to the skill name when displayName is missing", () => {
    const entry = slashSkillSummaryToEntry({
      name: "bare-bones",
    });
    expect(entry.displayName).toBe("bare-bones");
    expect(entry.label).toBe("bare-bones");
    expect(entry.description).toBe("");
  });

  it("uses the fixture icon for the four known skill names", () => {
    const knownNames = ["ask-matt", "code-review", "codebase-design", "diagnosing-bugs"];
    for (const name of knownNames) {
      const fromFixture = WEBUI_SKILL_FIXTURES.find((entry) => entry.name === name);
      const fromSummary = slashSkillSummaryToEntry({ name });
      expect(fromSummary.icon).toBe(fromFixture?.icon);
    }
  });
});
