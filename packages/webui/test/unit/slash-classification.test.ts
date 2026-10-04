import { describe, expect, it } from "vitest";
import { createElement } from "react";
import {
  WEBUI_BUILTIN_COMMANDS,
  WEBUI_RUN_COMMAND_NAMES,
  WEBUI_SKILL_FIXTURES,
  classifyWebuiSlashCommand,
  isWebuiRunnableCommand,
  sectionWebuiSlashPalette,
  type SlashCommandEntry,
} from "../../src/client/slash-palette.js";
import { resolveWebuiSubmissionIntent } from "../../src/client/projection/composer-state.js";

/**
 * Pure tests for the slash palette decision layer.
 *
 * The three-state classification (`runnable` / `inert-wired` /
 * `inert-unsupported`) is the surface the submit pipeline dispatches on.
 * `isWebuiRunnableCommand` is the boolean narrowing predicate the
 * `resolveWebuiSubmissionIntent` resolver reuses; both stay byte-identical
 * to the existing code — these tests pin the contract.
 *
 * Also covers the sectioning-pass order and the disabled-doesn't-dispatch
 * promise: a `supported: false` entry must never reach the run-command
 * intent path even when its name is in WEBUI_RUN_COMMAND_NAMES.
 */

// `icon` is a component, so it has to hand back a `ReactElement`. Nothing in
// this file renders one — the rows are classified and sectioned as plain
// objects — so the element only has to be real enough to match the signature.
const ICON: SlashCommandEntry["icon"] = () => createElement("span");

const newEntry = (name: string, supported: boolean): SlashCommandEntry => ({
  name,
  displayName: name,
  label: name,
  description: "",
  source_type: -1,
  icon: ICON,
  supported,
});

const skillEntry = (name: string): SlashCommandEntry => ({
  name,
  displayName: name,
  label: name,
  description: "",
  source_type: 1,
  source_kind: "plugin",
  paletteSection: "skills",
  icon: ICON,
  supported: true,
});

describe("classifyWebuiSlashCommand — three-state classification", () => {
  it("classifies a wired runnable name as `runnable`", () => {
    // help / new / compact / status / usage / model are the wired names.
    for (const name of WEBUI_RUN_COMMAND_NAMES) {
      const entry = newEntry(name, true);
      expect(classifyWebuiSlashCommand(entry)).toBe(`runnable`);
    }
  });

  it("classifies a wired but non-runnable name as `inert-wired` (skill case)", () => {
    // Skills are `supported: true` but their names are not in
    // WEBUI_RUN_COMMAND_NAMES; clicking inserts the slash and the user
    // edits before sending. They must NOT reach the run-command intent.
    const entry = skillEntry("ask-matt");
    expect(classifyWebuiSlashCommand(entry)).toBe("inert-wired");
  });

  it("classifies a disabled entry whose name IS in WEBUI_RUN_COMMAND_NAMES as `inert-unsupported`", () => {
    // Disabled entries stay inert even when the name itself would be
    // runnable if wired. The pin is critical: a `supported: false` row
    // must never reach the run-command path, no matter what its name is.
    for (const name of WEBUI_RUN_COMMAND_NAMES) {
      const entry = newEntry(name, false);
      expect(classifyWebuiSlashCommand(entry)).toBe(
        "inert-unsupported",
      );
    }
  });

  it("classifies a disabled entry whose name is NOT in WEBUI_RUN_COMMAND_NAMES as `inert-unsupported`", () => {
    const entry = newEntry("plan", false);
    expect(classifyWebuiSlashCommand(entry)).toBe("inert-unsupported");
  });
});

describe("isWebuiRunnableCommand — boolean narrowing predicate (unchanged contract)", () => {
  it("returns true only when both `supported: true` AND the name is in WEBUI_RUN_COMMAND_NAMES", () => {
    expect(isWebuiRunnableCommand(newEntry("help", true))).toBe(true);
    expect(isWebuiRunnableCommand(newEntry("compact", true))).toBe(true);
  });

  it("returns false for skills (supported: true but name not in WEBUI_RUN_COMMAND_NAMES)", () => {
    expect(isWebuiRunnableCommand(skillEntry("ask-matt"))).toBe(false);
    expect(isWebuiRunnableCommand(skillEntry("code-review"))).toBe(false);
  });

  it("returns false for disabled entries, even when the name is in WEBUI_RUN_COMMAND_NAMES", () => {
    // If a future harness port drops `compact` support, the entry stays
    // inert and the submit path falls through to the user-message path.
    expect(isWebuiRunnableCommand(newEntry("compact", false))).toBe(false);
  });
});

describe("sectionWebuiSlashPalette — order snapshot (default + skills sections)", () => {
  it("keeps every built-in in the default section, in declared order", () => {
    const builtins = WEBUI_BUILTIN_COMMANDS;
    const skills: SlashCommandEntry[] = [];
    const sectioned = sectionWebuiSlashPalette(builtins, skills);
    const defaultNames = sectioned
      .filter((entry) => entry.source_type === -1)
      .map((entry) => entry.name);
    // Stated as a rule rather than a frozen list. This test used to name
    // `["goal", "plan"]` and call itself "only the composer mode built-ins",
    // which is how a wired run-command row could join the palette without
    // anyone noticing which section it landed in.
    expect(defaultNames).toEqual(builtins.map((entry) => entry.name));
  });

  it("places the `skills` section after the default section, with the `技能` divider tag", () => {
    const builtins = WEBUI_BUILTIN_COMMANDS;
    const skills = WEBUI_SKILL_FIXTURES;
    const sectioned = sectionWebuiSlashPalette(builtins, skills);
    const skillsStart = sectioned.findIndex(
      (entry) => entry.paletteSection === "skills",
    );
    expect(skillsStart).toBeGreaterThan(0);
    // Every skills-section entry keeps the `skills` paletteSection.
    for (const entry of sectioned.slice(skillsStart)) {
      expect(entry.paletteSection).toBe("skills");
    }
    // The skills start with the first fixture and end with the last.
    const skillsNames = sectioned
      .slice(skillsStart)
      .map((entry) => entry.name);
    expect(skillsNames[0]).toBe(WEBUI_SKILL_FIXTURES[0]?.name);
    expect(skillsNames[skillsNames.length - 1]).toBe(
      WEBUI_SKILL_FIXTURES[WEBUI_SKILL_FIXTURES.length - 1]?.name,
    );
  });

  it("places the plugin entry after the default built-ins", () => {
    const builtins = WEBUI_BUILTIN_COMMANDS;
    const deployEntry: SlashCommandEntry = {
      name: "deploy-website",
      displayName: "deploy-website",
      label: "网站部署",
      description: "",
      source_type: -1,
      paletteSection: "special",
      icon: ICON,
      supported: false,
    };
    const sectioned = sectionWebuiSlashPalette(builtins, [deployEntry]);
    const defaultNames = sectioned
      .filter((entry) => entry.source_type === -1)
      .map((entry) => entry.name);
    expect(defaultNames).toEqual([...builtins.map((entry) => entry.name), "deploy-website"]);
  });
});

describe("resolveWebuiSubmissionIntent — operational consequence: disabled / inert entries do not reach run-command intent", () => {
  // The classification table above already pins the `inert-unsupported`
  // and `inert-wired` states. This block pins the *operational*
  // consequence: driving `resolveWebuiSubmissionIntent` directly with
  // every entry in `WEBUI_BUILTIN_COMMANDS ∪ WEBUI_SKILL_FIXTURES` as
  // the slash command match, the resolver must never produce a
  // `{ kind: "run-command", ... }` intent for entries whose
  // classification is not `runnable`. The set is the full registry — no
  // "spot check" on one command only — so a future addition of a runnable
  // entry is visible (new runnable → new run-command intent)
  // and a future regression (e.g. a supported:false entry sneaking into
  // run-command) is captured.
  const allEntries: SlashCommandEntry[] = [
    ...WEBUI_BUILTIN_COMMANDS,
    ...WEBUI_SKILL_FIXTURES,
  ];

  for (const entry of allEntries) {
    const classification = classifyWebuiSlashCommand(entry);
    it(`"${entry.name}" (${classification}) — resolver intent is operational, not just classified`, () => {
      // Drive the resolver the way the composer would: a draft that, if
      // the entry were runnable, would otherwise take path 3
      // (run-command). `commandInvocationInput` is non-empty so paths 1/2
      // (goal-only) don't steal the test for the `/goal` command — path 2
      // does fire for `goal` because its name is special-cased, which is
      // itself a "not run-command" outcome.
      const intent = resolveWebuiSubmissionIntent({
        draft: `/${entry.name} payload`,
        commandMatch: entry,
        commandInvocationName: entry.name,
        commandInvocationInput: "payload",
        goalMode: false,
      });
      if (classification === "runnable") {
        // The operational promise: a runnable entry reaches the host.
        expect(intent?.kind).toBe("run-command");
        if (intent?.kind === "run-command") {
          expect(intent.command.name).toBe(entry.name);
          expect(intent.input).toBe("payload");
        }
      } else {
        // The operational promise (negative): every non-runnable entry
        // — inert-wired (skills) and inert-unsupported (plan / fork /
        // memory) — must NOT reach the run-command intent.
        expect(intent?.kind).not.toBe("run-command");
      }
    });
  }

  it("summary — exactly the runnable entries produce a run-command intent (registry-wide)", () => {
    // Pull the run-command intents out of a single resolver pass over
    // the full registry. The set must equal the classification's
    // `runnable` rows. A future regression that lets inert-wired or
    // inert-unsupported rows sneak into run-command would show up here
    // as the set growing past the expected two rows.
    const runCommandIntents: { name: string; input?: string }[] = [];
    for (const entry of allEntries) {
      const intent = resolveWebuiSubmissionIntent({
        draft: `/${entry.name} payload`,
        commandMatch: entry,
        commandInvocationName: entry.name,
        commandInvocationInput: "payload",
        goalMode: false,
      });
      if (intent?.kind === "run-command") {
        runCommandIntents.push({
          name: intent.command.name,
          ...(intent.input !== undefined ? { input: intent.input } : {}),
        });
      }
    }
    // The invariant is an equality, not an empty list: the run-command
    // intents must be exactly the rows `classifyWebuiSlashCommand` calls
    // `runnable`. Adding a wired run-command row (compact) grows this set on
    // purpose; letting an inert row sneak in grows it wrongly. Either way the
    // set has to match the classification, which is what this asserts.
    const runnableEntries = allEntries.filter(
      (entry) => classifyWebuiSlashCommand(entry) === "runnable",
    );
    expect(runCommandIntents).toEqual(
      runnableEntries.map((entry) => ({ name: entry.name, input: "payload" })),
    );
  });
});

describe("host `runCommand` stub counter — disabled entries trigger zero host calls", () => {
  // The composer component's `submit` function dispatches on
  // `intent.kind`. For `run-command` it calls `runCommand(...)`; for every
  // other kind it goes through a different path (goal / submit-turn /
  // activate-goal-mode). The test mirrors the dispatcher's run-command
  // branch as a stub and drives the resolver with every registry entry;
  // the stub's call count must equal the number of runnable rows.
  //
  // This is the "stub counter" assertion the runbook asked for: it pins
  // the operational promise on the same code path the production
  // component takes, without mounting React. The component-side
  // `runCommand` call is not in `submitWebuiComposerTurn`'s signature
  // (the helper doesn't see the run-command path — the React submit
  // function owns it), so we replicate the dispatch here.

  const allEntries: SlashCommandEntry[] = [
    ...WEBUI_BUILTIN_COMMANDS,
    ...WEBUI_SKILL_FIXTURES,
  ];

  async function dispatchEntry(
    entry: SlashCommandEntry,
    runCommandStub: (args: { command: string; input?: string }) => Promise<unknown>,
  ): Promise<void> {
    const intent = resolveWebuiSubmissionIntent({
      draft: `/${entry.name} payload`,
      commandMatch: entry,
      commandInvocationName: entry.name,
      commandInvocationInput: "payload",
      goalMode: false,
    });
    // Mirror SessionComposer.tsx submit()'s `if (intent.kind === "run-command")`
    // branch — every other kind falls through to a different executor
    // (goal / submit-turn), which this test does not invoke.
    if (intent?.kind === "run-command") {
      await runCommandStub({
        command: intent.command.name,
        ...(intent.input !== undefined ? { input: intent.input } : {}),
      });
    }
  }

  it("zero calls for the plan composer mode", async () => {
    const calls: { command: string; input?: string }[] = [];
    const stub = async (args: { command: string; input?: string }) => {
      calls.push(args);
      return { output: "ok" };
    };
    const entry = WEBUI_BUILTIN_COMMANDS.find(
      (candidate) => candidate.name === "plan",
    );
    expect(entry).toBeDefined();
    await dispatchEntry(entry as SlashCommandEntry, stub);
    expect(calls).toEqual([]);
  });

  it("zero calls for every skill fixture (ask-matt / code-review / codebase-design / diagnosing-bugs)", async () => {
    const calls: { command: string; input?: string }[] = [];
    const stub = async (args: { command: string; input?: string }) => {
      calls.push(args);
      return { output: "ok" };
    };
    for (const entry of WEBUI_SKILL_FIXTURES) {
      await dispatchEntry(entry, stub);
    }
    expect(calls).toEqual([]);
  });

  it("zero calls for the inert-wired `goal` entry — submit path routes it through composerMode, not runCommand", async () => {
    const calls: { command: string; input?: string }[] = [];
    const stub = async (args: { command: string; input?: string }) => {
      calls.push(args);
      return { output: "ok" };
    };
    const goalEntry = WEBUI_BUILTIN_COMMANDS.find(
      (candidate) => candidate.name === "goal",
    );
    expect(goalEntry).toBeDefined();
    await dispatchEntry(goalEntry as SlashCommandEntry, stub);
    expect(calls).toEqual([]);
  });

  it("registry-wide — only the runnable rows reach the runCommand stub", async () => {
    const calls: { command: string; input?: string }[] = [];
    const stub = async (args: { command: string; input?: string }) => {
      calls.push(args);
      return { output: "ok" };
    };
    for (const entry of allEntries) {
      await dispatchEntry(entry, stub);
    }
    // Composer modes and skills must not call the host at all. This used to
    // assert `[]` over the whole registry, which is only true while no
    // run-command row exists — it read as a general promise but was really a
    // snapshot of an empty palette. Now it states the real rule: the stub is
    // called once per runnable row, and for those rows only.
    const runnableEntries = allEntries.filter(
      (entry) => classifyWebuiSlashCommand(entry) === "runnable",
    );
    expect(calls.map((call) => call.command)).toEqual(
      runnableEntries.map((entry) => entry.name),
    );
  });
});

describe("classification ↔ isWebuiRunnableCommand consistency", () => {
  it("`runnable` matches `isWebuiRunnableCommand === true` for every entry", () => {
    const allEntries: SlashCommandEntry[] = [
      ...WEBUI_BUILTIN_COMMANDS,
      ...WEBUI_SKILL_FIXTURES,
    ];
    for (const entry of allEntries) {
      const classification = classifyWebuiSlashCommand(entry);
      const runnable = isWebuiRunnableCommand(entry);
      if (classification === "runnable") {
        expect(runnable, entry.name).toBe(true);
      } else {
        expect(runnable, entry.name).toBe(false);
      }
    }
  });

  it("classification returns one of exactly three values for every entry", () => {
    const allEntries: SlashCommandEntry[] = [
      ...WEBUI_BUILTIN_COMMANDS,
      ...WEBUI_SKILL_FIXTURES,
    ];
    for (const entry of allEntries) {
      const classification = classifyWebuiSlashCommand(entry);
      expect(
        classification === "runnable" ||
          classification === "inert-wired" ||
          classification === "inert-unsupported",
        entry.name,
      ).toBe(true);
    }
  });
});
