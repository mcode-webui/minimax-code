// Slash palette for the composer hinting model.
//
// Uses the desktop palette's three data pools (built-in commands, the plugin
// registry, and the skills resolver), sectioning, and four-rank filtering.
// The built-in list is intentionally scoped to the composer modes supported
// here; behavior fields remain compatible with the desktop record shape.
//
// Source attribution: `docs/webui-visual-language.md` (visual language),
// ADR 0009 (reuse the desktop's vocabulary), `chunks/10118-*` (palette
// data structure), `chunks/60554-*` (i18n strings).

import type { ReactElement } from "react";
import {
  WebuiIconCommandCompact,
  WebuiIconCommandGoal,
  WebuiIconCommandPlan,
  WebuiIconSites,
  WebuiIconSkillAskMatt,
  WebuiIconSkillCodebaseDesign,
  WebuiIconSkillCodeReview,
  WebuiIconSkillDiagnosingBugs,
  WebuiIconSkillGeneric,
} from "./icons.js";

/** Behaviour an entry can declare. Mirrors the desktop's three special fields. */
export type SlashComposerMode = "goal" | "plan" | "review";
export type SlashSendIntent = "cloud-handoff" | "review";
export type SlashDirectAction = "memory" | "fork";

/** Where an entry lives in the popover. The desktop uses "special" only. */
export type SlashPaletteSection = "special" | "skills";

/**
 * Three states a slash command can be in at runtime. Distinct from the
 * static `supported` flag (a boolean capability declaration):
 *   - `runnable`            — `supported: true` AND the name is in
 *                             `WEBUI_RUN_COMMAND_NAMES`. Submit dispatches
 *                             the host's `runCommand` capability.
 *   - `inert-wired`         — `supported: true` BUT the name is NOT in
 *                             `WEBUI_RUN_COMMAND_NAMES` (skills, for example).
 *                             Click inserts `/<name> ` into the composer; the
 *                             submit path treats the slash as a user message
 *                             the user can edit before sending — same as the
 *                             desktop's default behaviour for entries without
 *                             `composerMode` / `sendIntent` / `directAction`.
 *   - `inert-unsupported`   — `supported: false`. The host port is not
 *                             wired. The row renders inert (aria-disabled,
 *                             no click, no hover tint, dimmed icon + label +
 *                             description); clicking is a no-op.
 *
 * The boolean `supported` flag stays the wire shape; the classification is
 * the runtime decision `classifyWebuiSlashCommand` makes on top of it. No
 * `supported: "fallback"` literal was added — runtime classification is the
 * same as the original capability check, just spelled out as three states
 * for the submit pipeline to dispatch on without renaming `supported`.
 */
export type WebuiCommandClassification =
  | "runnable"
  | "inert-wired"
  | "inert-unsupported";

/**
 * One row in the slash palette. Mirrors the desktop record shape so a future
 * `listSkills` RPC can be slotted into `resolveWebuiSkills` without renaming.
 *
 * `supported` is the WebUI-specific capability flag — entries where the
 * harness port is not wired render as inert rows (`aria-disabled`, no click,
 * no hover tint, dimmed icon + label + description). The runtime
 * classification (see `WebuiCommandClassification`) extends this with the
 * `inert-wired` state for supported-but-not-runnable entries (skills).
 */
export interface SlashCommandEntry {
  readonly name: string;
  readonly displayName: string;
  readonly label: string;
  readonly description: string;
  readonly source_type: -1 | 0 | 1;
  readonly icon: (props: { className?: string }) => ReactElement;
  readonly composerMode?: SlashComposerMode;
  readonly sendIntent?: SlashSendIntent;
  readonly directAction?: SlashDirectAction;
  readonly slashPrompt?: string;
  readonly paletteSection?: SlashPaletteSection;
  readonly paletteDescriptionClassName?: string;
  readonly searchTerms?: readonly string[];
  readonly display_name?: string;
  readonly display_description?: string;
  readonly source_kind?: string;
  /**
   * WebUI-specific capability flag — three states described above:
   *   - `true`  → host port wired; dispatch as runnable if the name is in
   *               WEBUI_RUN_COMMAND_NAMES, otherwise inert-wired.
   *   - `false` → host port not wired; render inert-unsupported.
   */
  readonly supported: boolean;
}

/**
 * Built-in commands. The sectioning pass places registered plugin commands
 * after these entries, then the dynamically resolved skills.
 *
 * Capability gating today is the static `supported` flag. Goal is backed by
 * the goal operations, plan entry is backed by the send-message
 * `plan-entry` intent, and compact is backed by the harness port's
 * `runCommand` — `server/commands/runner.ts` routes `command === "compact"`
 * into `requestCompaction`, and the operation is registered in
 * `server/operation/operations.ts`. Commands without a WebUI path remain
 * inert until their transport is wired.
 *
 * `compact` is the one run-command built-in exposed so far. The remaining
 * names in `WEBUI_RUN_COMMAND_NAMES` (`help`, `new`, `status`, `usage`,
 * `model`) are reachable at the transport layer but have no palette row, so
 * a user cannot discover them; they need their own entries before they can
 * be claimed as shipped.
 */
export const WEBUI_BUILTIN_COMMANDS: readonly SlashCommandEntry[] = [
  {
    name: "goal",
    displayName: "goal",
    label: "目标",
    description: "为当前会话设置或更新目标",
    source_type: -1,
    composerMode: "goal",
    icon: WebuiIconCommandGoal,
    supported: true,
  },
  {
    name: "plan",
    displayName: "plan",
    label: "计划",
    description: "执行前先梳理复杂任务",
    source_type: -1,
    composerMode: "plan",
    icon: WebuiIconCommandPlan,
    supported: true,
  },
  {
    name: "compact",
    displayName: "compact",
    label: "压缩",
    description: "压缩当前会话上下文；可附带说明，如 /compact 保留代码变更",
    source_type: -1,
    icon: WebuiIconCommandCompact,
    supported: true,
  },
];

/**
 * Plugin registry. Mirrors the desktop's `ez` map: a fixed name → metadata
 * table for entries that should sit between the built-in commands and the
 * skills section. The desktop currently registers exactly one — deploy-website.
 *
 * The WebUI's harness port has no deploy path today, so the entry renders
 * inert; the row is the desktop's row, just non-functional.
 */
export const WEBUI_PLUGIN_REGISTRY: Record<
  string,
  Pick<
    SlashCommandEntry,
    | "name"
    | "displayName"
    | "label"
    | "description"
    | "source_type"
    | "icon"
    | "paletteSection"
    | "supported"
  >
> = {
  "deploy-website": {
    name: "deploy-website",
    displayName: "deploy-website",
    label: "网站部署",
    description:
      "支持静态网站部署，适合前端网站分享、作品展示和快速发布。",
    source_type: -1,
    icon: WebuiIconSites,
    paletteSection: "special",
    supported: false,
  },
};

/**
 * Static skill catalogue (fallback). The harness port now exposes a
 * `listSkills(agentName, ...)` RPC, so `resolveWebuiSlashSkills` prefers
 * the harness-supplied registry when available. The four `mavis-*`
 * fixtures below (descriptions quoted verbatim from the local
 * `~/.hermes/skills` registry) ship as the fallback path: when the
 * harness port rejects, returns an empty list, or is not wired at all,
 * the resolver returns these fixtures so the popover stays usable.
 *
 * Skills are `supported: true` so the popover row is clickable in 1:1 with
 * the desktop. Clicking inserts `/<skill-name> ` into the composer; the
 * submit path doesn't dispatch `runCommand` for skill names (they're not
 * in `WEBUI_RUN_COMMAND_NAMES`), so the slash becomes a user message that
 * the user can edit before sending — same as the desktop's default
 * behaviour for entries without `composerMode` / `sendIntent` /
 * `directAction`.
 */
export const WEBUI_SKILL_FIXTURES: readonly SlashCommandEntry[] = [
  {
    name: "ask-matt",
    displayName: "ask-matt",
    label: "ask-matt",
    description: "Ask which skill or flow fits your situation.",
    source_type: 1,
    source_kind: "plugin",
    icon: WebuiIconSkillAskMatt,
    paletteSection: "skills",
    supported: true,
  },
  {
    name: "code-review",
    displayName: "code-review",
    label: "code-review",
    description:
      "Review the changes since a fixed point (commit, branch, tag, or merge-base) along two axes: Standards and Spec.",
    source_type: 1,
    source_kind: "plugin",
    icon: WebuiIconSkillCodeReview,
    paletteSection: "skills",
    supported: true,
  },
  {
    name: "codebase-design",
    displayName: "codebase-design",
    label: "codebase-design",
    description:
      "Shared vocabulary for designing deep modules. Use when the user wants to introduce, redesign, or reshape a module's interface.",
    source_type: 1,
    source_kind: "plugin",
    icon: WebuiIconSkillCodebaseDesign,
    paletteSection: "skills",
    supported: true,
  },
  {
    name: "diagnosing-bugs",
    displayName: "diagnosing-bugs",
    label: "diagnosing-bugs",
    description:
      "Diagnosis loop for hard bugs and performance regressions. Use when the user reports something broken, throwing, or slow.",
    source_type: 1,
    source_kind: "plugin",
    icon: WebuiIconSkillDiagnosingBugs,
    paletteSection: "skills",
    supported: true,
  },
];

/**
 * Minimal projection of the harness `SkillInfo` the slash palette needs.
 * Mirrors `WebuiSkillEntry` from the server side: the harness ships only
 * these three fields so the popover can render without dragging the full
 * `SkillInfo` shape across the websocket.
 */
export interface WebuiSlashSkillSummary {
  readonly name: string;
  readonly displayName?: string;
  readonly description?: string;
}

/**
 * Skills resolver outcome — the three states the resolver can land in.
 *
 *   - `harness`           — the harness port returned one or more skills.
 *                          The popover shows the live registry.
 *   - `harness-empty`     — the harness port returned successfully with
 *                          an empty list. We keep the fixtures so the
 *                          popover still surfaces the local skill
 *                          catalogue, but the caller can tell the harness
 *                          was reachable. UI may show a "harness had no
 *                          skills" hint.
 *   - `fixtures-fallback` — the harness port was unavailable (no fetcher
 *                          supplied, or the call rejected). The fixtures
 *                          carry the popover, and the caller should pin
 *                          the fallback path with diagnostics.
 *
 * The `source` tag is the production consumer of the three-state
 * classification: callers gate features (icons, support flags, harness
 * diagnostics) on it; the popover rendering stays unchanged.
 */
export type WebuiSlashResolveSource =
  | "harness"
  | "harness-empty"
  | "fixtures-fallback";

export interface WebuiSlashSkillsResult {
  readonly source: WebuiSlashResolveSource;
  readonly skills: readonly SlashCommandEntry[];
}

/**
 * Skills resolver. Mirrors the desktop's `listSkillHub` (signed-out web) /
 * `listSkills(agentName, ...)` split.
 *
 * The harness port now exposes a `listSkills` RPC, so the preferred path
 * is `fetcher()` — the returned skills replace the fixture set above. If
 * the call rejects (port unavailable, RPC error, network drop) we keep the
 * fixtures so the popover stays usable rather than going empty.
 *
 * `WEBUI_PLUGIN_REGISTRY` is always merged in regardless of the fetcher
 * outcome; its entries sit in the `special` section so the sectioning pass
 * routes them to the default row, not under the `技能` divider.
 *
 * Returns a tagged result so callers can react to the three resolution
 * outcomes (harness / harness-empty / fixtures-fallback) — see
 * `WebuiSlashResolveSource`.
 */
export async function resolveWebuiSlashSkills(options?: {
  readonly fetcher?: () => Promise<readonly WebuiSlashSkillSummary[]>;
}): Promise<WebuiSlashSkillsResult> {
  const pluginEntries = Object.values(WEBUI_PLUGIN_REGISTRY).map((entry) => ({
    ...entry,
    display_name: entry.label,
    display_description: entry.description,
    source_kind: "plugin",
  }));
  const resolved = await resolveSkillEntries(options?.fetcher);
  return {
    source: resolved.source,
    skills: [...pluginEntries, ...resolved.skills],
  };
}

async function resolveSkillEntries(
  fetcher?: () => Promise<readonly WebuiSlashSkillSummary[]>,
): Promise<{ source: WebuiSlashResolveSource; skills: SlashCommandEntry[] }> {
  if (fetcher) {
    try {
      const skills = await fetcher();
      const fromHarness = skills.map(slashSkillSummaryToEntry);
      if (fromHarness.length > 0) {
        return { source: "harness", skills: fromHarness };
      }
      // Harness returned successfully but with no skills. Don't substitute
      // the fixtures silently — surface the empty result so callers can
      // distinguish it from a port failure.
      return { source: "harness-empty", skills: [] };
    } catch {
      // Swallow and fall through to fixtures so a malformed probe entry stays
      // a recoverable problem rather than an empty popover.
    }
  }
  return { source: "fixtures-fallback", skills: [...WEBUI_SKILL_FIXTURES] };
}

/**
 * Converts a single harness skill summary into the popover's row shape. The
 * mapping is intentionally tiny: name → name, displayName → label /
 * displayName, description → description. Everything else (icon, palette
 * section, supported) is filled in here so callers don't have to repeat the
 * wiring. Exported so the composer can re-section the palette from the live
 * registry without going through the async resolver twice.
 */
export function slashSkillSummaryToEntry(
  skill: WebuiSlashSkillSummary,
): SlashCommandEntry {
  const displayName = skill.displayName?.trim() || skill.name;
  return {
    name: skill.name,
    displayName,
    label: displayName,
    description: skill.description ?? "",
    source_type: 1,
    source_kind: "plugin",
    icon: iconForSkillName(skill.name),
    paletteSection: "skills",
    supported: true,
  };
}

const SKILL_ICON_BY_NAME: Record<string, WebuiIconComponent> = {
  "ask-matt": WebuiIconSkillAskMatt,
  "code-review": WebuiIconSkillCodeReview,
  "codebase-design": WebuiIconSkillCodebaseDesign,
  "diagnosing-bugs": WebuiIconSkillDiagnosingBugs,
};

type WebuiIconComponent = (props: { className?: string }) => ReactElement;

function iconForSkillName(name: string): WebuiIconComponent {
  return SKILL_ICON_BY_NAME[name] ?? WebuiIconSkillGeneric;
}

/**
 * The default section holds built-ins plus entries whose `paletteSection` is
 * `"special"` (currently `deploy-website`); the skills section holds
 * everything else. The order is preserved within each section.
 */
export function sectionWebuiSlashPalette(
  builtins: readonly SlashCommandEntry[],
  skills: readonly SlashCommandEntry[],
): SlashCommandEntry[] {
  const isInDefault = (entry: SlashCommandEntry): boolean =>
    entry.source_type === -1 || entry.paletteSection === "special";

  const inDefault: SlashCommandEntry[] = [];
  const inSkills: SlashCommandEntry[] = [];
  for (const skill of skills) {
    if (isInDefault(skill)) inDefault.push(skill);
    else inSkills.push(skill);
  }

  // Tag every skills-section entry so the popover can render the `技能`
  // header before them. Mirrors the desktop's static `技能` divider that
  // appears between the default section and the skill rows.
  const taggedSkills = inSkills.map((entry) => ({
    ...entry,
    paletteSection: entry.paletteSection ?? "skills",
  }));

  return [...builtins, ...inDefault, ...taggedSkills];
}

/**
 * Optional lite-mode filter. Mirrors the desktop's `tL` branch: drop every
 * built-in except `goal` and `plan`, keep all skills. The WebUI does not
 * surface a lite mode today, but the predicate is here so a future flag
 * can be wired without rebuilding the sectioning.
 */
export function applyWebuiSlashLiteMode(
  palette: readonly SlashCommandEntry[],
  lite: boolean,
): SlashCommandEntry[] {
  if (!lite) return [...palette];
  return palette.filter(
    (entry) =>
      entry.source_type !== -1 ||
      entry.composerMode === "goal" ||
      entry.composerMode === "plan",
  );
}

/**
 * Rank-based filter. Mirrors the desktop's four-rank scoring:
 *
 *   0 — exact match on name or displayName
 *   1 — startsWith on name or displayName
 *   2 — includes on name or displayName
 *   3 — substring across every searchable field, including searchTerms
 *
 * Within the same rank, items keep their original palette order. Empty
 * query returns the palette untouched.
 */
export function rankWebuiSlashPalette(
  palette: readonly SlashCommandEntry[],
  query: string,
): SlashCommandEntry[] {
  const trimmed = query.trim();
  if (!trimmed) return [...palette];
  const needle = trimmed.toLowerCase();

  const scored: { cmd: SlashCommandEntry; rank: number; idx: number }[] = [];
  palette.forEach((entry, idx) => {
    const name = entry.name.toLowerCase();
    const display = entry.displayName.toLowerCase();
    let rank: number;
    if (name === needle || display === needle) rank = 0;
    else if (name.startsWith(needle) || display.startsWith(needle)) rank = 1;
    else if (name.includes(needle) || display.includes(needle)) rank = 2;
    else {
      const haystack = [
        entry.name,
        entry.displayName,
        entry.label,
        entry.description,
        entry.display_name,
        entry.display_description,
        ...(entry.searchTerms ?? []),
      ]
        .filter((value): value is string => Boolean(value))
        .join(" ")
        .toLowerCase();
      if (!haystack.includes(needle)) return;
      rank = 3;
    }
    scored.push({ cmd: entry, rank, idx });
  });
  scored.sort((left, right) => left.rank - right.rank || left.idx - right.idx);
  return scored.map((entry) => entry.cmd);
}

/**
 * Composed API: section + lite-mode filter. Returns the static slice; skills
 * are awaited in `buildWebuiSlashPaletteAsync` below because the desktop's
 * skills come from a runtime IPC call.
 */
export function buildWebuiSlashPalette(options: {
  readonly skills?: readonly SlashCommandEntry[];
  readonly lite?: boolean;
}): SlashCommandEntry[] {
  const skills = options.skills ?? [];
  const sectioned = sectionWebuiSlashPalette(WEBUI_BUILTIN_COMMANDS, skills);
  return applyWebuiSlashLiteMode(sectioned, !!options.lite);
}

/**
 * Async form: resolves the skills pool, then runs the sectioning pass. The
 * WebUI today calls this once per popover open (or once per session if the
 * popover persists across opens) so the resolver cost stays bounded.
 */
export async function buildWebuiSlashPaletteAsync(options: {
  readonly lite?: boolean;
  readonly fetcher?: () => Promise<readonly WebuiSlashSkillSummary[]>;
} = {}): Promise<SlashCommandEntry[]> {
  const resolved = await resolveWebuiSlashSkills({
    fetcher: options.fetcher,
  });
  return buildWebuiSlashPalette({ skills: resolved.skills, lite: options.lite });
}

/**
 * Names the harness port's `runCommand` accepts. Mirrors the server-side
 * validation list in `packages/webui/src/server/operations.ts`; the
 * `WebuiRunCommandName` literal union is the single source of truth on the
 * client side. `isWebuiRunnableCommand` narrows a `SlashCommandEntry` so
 * the submit handler can pass `command.name` to `runCommand` without an
 * unsafe cast.
 */
export const WEBUI_RUN_COMMAND_NAMES = [
  "help",
  "new",
  "compact",
  "status",
  "usage",
  "model",
] as const;
export type WebuiRunCommandName = (typeof WEBUI_RUN_COMMAND_NAMES)[number];

export function isWebuiRunnableCommand(
  entry: SlashCommandEntry,
): entry is SlashCommandEntry & {
  readonly name: WebuiRunCommandName;
  readonly supported: true;
} {
  return (
    entry.supported &&
    (WEBUI_RUN_COMMAND_NAMES as readonly string[]).includes(entry.name)
  );
}

/**
 * Pure three-state classification of a slash command. Pairs with
 * `isWebuiRunnableCommand` (a boolean narrowing predicate); the
 * classification is the broader decision the popover / submit pipeline
 * dispatches on.
 *
 * Behaviour table:
 *
 *   | entry.supported | name ∈ WEBUI_RUN_COMMAND_NAMES | classification        |
 *   |------------------|-------------------------------|----------------------|
 *   | true             | yes                           | runnable             |
 *   | true             | no                            | inert-wired          |
 *   | false            | yes                           | inert-unsupported    |
 *   | false            | no                            | inert-unsupported    |
 *
 * The split between `inert-wired` and `inert-unsupported` matters because
 * the submit path treats `inert-wired` rows as editable user messages (the
 * slash becomes the start of the draft the user keeps typing) while
 * `inert-unsupported` rows render as inert UI (no click, no hover tint).
 * `resolveWebuiSubmissionIntent` already implements the runtime version of
 * this table; this function exists to give the tests a typed handle on the
 * classification without going through the React component.
 */
export function classifyWebuiSlashCommand(
  entry: SlashCommandEntry,
): WebuiCommandClassification {
  if (!entry.supported) return "inert-unsupported";
  if ((WEBUI_RUN_COMMAND_NAMES as readonly string[]).includes(entry.name)) {
    return "runnable";
  }
  return "inert-wired";
}
