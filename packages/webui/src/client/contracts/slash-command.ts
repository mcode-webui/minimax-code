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
