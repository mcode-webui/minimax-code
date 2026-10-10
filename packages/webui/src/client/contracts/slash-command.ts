export const WEBUI_RUN_COMMAND_NAMES = [
  "help",
  "new",
  "compact",
  "status",
  "usage",
  "model",
] as const;

export type WebuiRunCommandName = (typeof WEBUI_RUN_COMMAND_NAMES)[number];
export type WebuiCommandClassification =
  | "runnable"
  | "inert-wired"
  | "inert-unsupported";

export type SlashComposerMode = "goal" | "plan" | "review";
export type SlashSendIntent = "cloud-handoff" | "review";
export type SlashDirectAction = "memory" | "fork";
export type SlashPaletteSection = "special" | "skills";

export interface WebuiSlashPaletteFields extends WebuiSlashCommandFields {
  readonly displayName: string;
  readonly label: string;
  readonly description: string;
  readonly source_type: -1 | 0 | 1;
  readonly composerMode?: SlashComposerMode;
  readonly paletteSection?: SlashPaletteSection;
  readonly searchTerms?: readonly string[];
  readonly display_name?: string;
  readonly display_description?: string;
}

export function sectionWebuiSlashPalette<T extends WebuiSlashPaletteFields>(
  builtins: readonly T[],
  skills: readonly T[],
): T[] {
  const isInDefault = (entry: T): boolean =>
    entry.source_type === -1 || entry.paletteSection === "special";
  const inDefault: T[] = [];
  const inSkills: T[] = [];
  for (const skill of skills) (isInDefault(skill) ? inDefault : inSkills).push(skill);
  const taggedSkills: T[] = inSkills.map((entry) => ({
    ...entry,
    paletteSection: entry.paletteSection ?? "skills",
  }));
  return [...builtins, ...inDefault, ...taggedSkills];
}

export function applyWebuiSlashLiteMode<T extends WebuiSlashPaletteFields>(
  palette: readonly T[],
  lite: boolean,
): T[] {
  if (!lite) return [...palette];
  return palette.filter((entry) =>
    entry.source_type !== -1 || entry.composerMode === "goal" || entry.composerMode === "plan",
  );
}

export function rankWebuiSlashPalette<T extends WebuiSlashPaletteFields>(
  palette: readonly T[],
  query: string,
): T[] {
  const trimmed = query.trim();
  if (!trimmed) return [...palette];
  const needle = trimmed.toLowerCase();
  const scored: { cmd: T; rank: number; idx: number }[] = [];
  palette.forEach((entry, idx) => {
    const name = entry.name.toLowerCase();
    const display = entry.displayName.toLowerCase();
    let rank: number;
    if (name === needle || display === needle) rank = 0;
    else if (name.startsWith(needle) || display.startsWith(needle)) rank = 1;
    else if (name.includes(needle) || display.includes(needle)) rank = 2;
    else {
      const haystack = [entry.name, entry.displayName, entry.label, entry.description,
        entry.display_name, entry.display_description, ...(entry.searchTerms ?? [])]
        .filter((value): value is string => Boolean(value)).join(" ").toLowerCase();
      if (!haystack.includes(needle)) return;
      rank = 3;
    }
    scored.push({ cmd: entry, rank, idx });
  });
  scored.sort((left, right) => left.rank - right.rank || left.idx - right.idx);
  return scored.map((entry) => entry.cmd);
}

export interface WebuiSlashCommandFields {
  readonly name: string;
  readonly supported: boolean;
}

export function isWebuiRunnableCommand(
  entry: WebuiSlashCommandFields,
): entry is WebuiSlashCommandFields & {
  readonly name: WebuiRunCommandName;
  readonly supported: true;
} {
  return (
    entry.supported &&
    (WEBUI_RUN_COMMAND_NAMES as readonly string[]).includes(entry.name)
  );
}

export function classifyWebuiSlashCommand(
  entry: WebuiSlashCommandFields,
): WebuiCommandClassification {
  if (!entry.supported) return "inert-unsupported";
  if ((WEBUI_RUN_COMMAND_NAMES as readonly string[]).includes(entry.name))
    return "runnable";
  return "inert-wired";
}
