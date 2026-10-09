export interface WebuiCommandDescriptor {
  readonly name: string;
  readonly description: string;
}

export const WEBUI_COMMAND_DESCRIPTORS = {
  help: { name: "help", description: "Show available commands" },
  new: { name: "new", description: "Start a fresh session in the current workspace" },
  compact: { name: "compact", description: "Shorten the active conversation" },
  status: { name: "status", description: "Show account and model status" },
  usage: { name: "usage", description: "Show session usage" },
  model: { name: "model", description: "Choose a model" },
} as const satisfies Record<string, WebuiCommandDescriptor>;

export type WebuiCommandName = keyof typeof WEBUI_COMMAND_DESCRIPTORS;

