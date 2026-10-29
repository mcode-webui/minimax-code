// The typed plugin action adapter.
//
// `pluginManagement` is one wire operation standing in front of 29 actions, so
// the client's only handle on it used to be a string:
//
//   const call = (action: string, input?: Record<string, unknown>) =>
//     port.pluginManagement({ action: action as never, ... })
//
// `as never` was the tell. It silenced the compiler at the one place where the
// action name is the entire contract, so `call("listMarketplacePluginsTypo")`
// and `call("installPlugin", { wrong: 1 })` both compiled and both failed at
// runtime, in the browser, against a validator on the other side of a socket.
// Every caller also had to know the wire spelling, which made the business
// action and the wire verb the same thing.
//
// This module separates them. Each action gets:
//   * a named input type describing the fields the server's `INPUT_SHAPES`
//     declares for it — required and optional, with their real types;
//   * a named result reader for the shape callers actually consume.
//
// Nothing here validates at runtime; the server still does that, unchanged. The
// point is that a wrong name or a wrong field is now a compile error at the
// call site rather than a rejected request.
//
// The three populations this covers — the shared union, the server's accepted set
// and the server's input shapes — are proved to agree, exhaustively and without
// duplicates, by `test/unit/plugin-action-inventory.test.ts`.

import type { WebuiPluginManagementAction } from "../../../../shared/plugin-management.js";

/** A row shape an agent's `initialDefinition`/`config` carries. */
export interface WebuiPluginAgentDefinition {
  readonly name: string;
  readonly description: string;
  readonly systemPrompt: string;
  readonly model?: string;
  readonly effort?: string;
  readonly tools?: readonly string[];
  readonly disallowedTools?: readonly string[];
  readonly mcpServers?: Readonly<Record<string, string>>;
  readonly skills?: readonly string[];
  readonly mavis?: unknown;
}

/**
 * The GitHub source an import names. `repositoryUrl` and `commitSha` are both
 * required and non-blank, and the server rejects the request outright without
 * them — so they are required here rather than optional.
 */
export interface WebuiPluginGithubSource {
  readonly repositoryUrl: string;
  readonly commitSha: string;
  readonly subPath?: string;
}

/** One named row, as the listings hand it back. */
export type WebuiPluginRow = Record<string, unknown>;

/** A list answer, tolerating the runtime's several spellings for "the rows". */
export interface WebuiPluginListResult {
  readonly [key: string]: unknown;
}

/**
 * Per-action input, mirroring the server validator's `INPUT_SHAPES`.
 *
 * An action with no declared fields takes `undefined`: `listApps` has an empty
 * shape, and accepting a `Record` for it would let a caller pass fields the
 * validator ignores.
 */
export interface WebuiPluginActionInputs {
  listApps: undefined;
  listMarketplacePlugins: {
    readonly limit?: number;
    readonly cursor?: string;
    readonly offset?: number;
    readonly keyword?: string;
    readonly source?: number;
    readonly category?: number;
    readonly skillLimit?: number;
  };
  listInstalledPlugins: {
    readonly limit?: number;
    readonly offset?: number;
    readonly keyword?: string;
  };
  previewGithubPlugin: { readonly url: string };
  importGithubPlugin: { readonly source: WebuiPluginGithubSource };
  installPlugin: { readonly pluginName: string; readonly source?: number };
  uninstallPlugin: { readonly pluginName: string; readonly source?: number };
  enablePlugin: { readonly pluginName: string; readonly source?: number };
  disablePlugin: { readonly pluginName: string; readonly source?: number };

  listRuntimeSkills: {
    readonly agentName?: string;
    readonly sessionId?: string;
    readonly workspaceDir?: string;
    readonly includePluginSkills?: boolean;
  };
  listManageableSkills: {
    readonly limit?: number;
    readonly cursor?: string;
    readonly keyword?: string;
    readonly excludeBuiltin?: boolean;
  };
  setSkillEnabled: {
    readonly skillName: string;
    readonly enabled: boolean;
    readonly locationUri?: string;
  };
  deleteSkill: { readonly skillName: string; readonly locationUri?: string };
  listSkillHub: {
    readonly limit?: number;
    readonly keyword?: string;
    readonly cursor?: string;
    readonly sourceType?: number;
    readonly sortType?: number;
  };
  installSkill: {
    readonly url: string;
    readonly agentName?: string;
    readonly isFromGit?: boolean;
    readonly displayName?: string;
    readonly publisherSourceType?: number;
    readonly creatorInfo?: Record<string, unknown>;
  };
  createSkill: {
    readonly name: string;
    readonly description: string;
    readonly content: string;
  };

  listMcpServers: { readonly keyword?: string };
  getMcpServer: { readonly name: string };
  createMcpServer: {
    readonly name: string;
    readonly config: Record<string, unknown>;
    readonly enabled?: boolean;
  };
  updateMcpServer: {
    readonly name: string;
    readonly config: Record<string, unknown>;
  };
  deleteMcpServer: { readonly name: string };
  setMcpServerEnabled: { readonly name: string; readonly enabled: boolean };
  testMcpServer: { readonly name: string };

  listAgents: {
    readonly limit?: number;
    readonly offset?: number;
    readonly search?: string;
    readonly include?: string;
  };
  readAgentAvatar: { readonly name: string };
  getAgent: { readonly name: string };
  createAgent: {
    readonly name: string;
    readonly displayName?: string;
    readonly description?: string;
    readonly systemPrompt?: string;
    readonly initialDefinition?: WebuiPluginAgentDefinition;
  };
  updateAgent: {
    readonly name: string;
    readonly displayName?: string;
    readonly description?: string;
    readonly systemPrompt?: string;
  };
  deleteAgent: { readonly name: string };
}

/** The adapter's input for one action, widened for the transport envelope. */
export type WebuiPluginActionInput<K extends WebuiPluginManagementAction> =
  WebuiPluginActionInputs[K];

export type WebuiPluginPort = (request: {
  readonly action: WebuiPluginManagementAction;
  readonly input?: Record<string, unknown>;
}) => Promise<unknown>;

export const WEBUI_PLUGIN_NOT_CONNECTED =
  "Plugin management is not connected to the runtime";

/**
 * The typed adapter. One method per action, so a caller asks for what it wants
 * rather than naming a wire verb and hoping the string is spelled right.
 */
/**
 * One intent: a named command and the fields that command declares.
 *
 * A view that used to pass a bare wire verb plus an untyped row now builds one of
 * these instead. The union is narrow on purpose — it names only the commands a
 * view can express, and each member carries exactly that command's fields — so
 * the payload is checked against the command it will reach rather than against
 * whatever the runtime happens to send back.
 */
export type WebuiPluginIntent =
  | { readonly kind: "installPlugin"; readonly pluginName: string; readonly source?: number }
  | { readonly kind: "uninstallPlugin"; readonly pluginName: string; readonly source?: number }
  | { readonly kind: "enablePlugin"; readonly pluginName: string; readonly source?: number }
  | { readonly kind: "disablePlugin"; readonly pluginName: string; readonly source?: number }
  | { readonly kind: "importGithubPlugin"; readonly source: WebuiPluginGithubSource }
  | {
      readonly kind: "installSkill";
      readonly url: string;
      readonly displayName?: string;
      readonly publisherSourceType?: number;
      readonly isFromGit?: boolean;
      readonly creatorInfo?: Record<string, unknown>;
    }
  | {
      readonly kind: "createSkill";
      readonly name: string;
      readonly description: string;
      readonly content: string;
    }
  | {
      readonly kind: "setSkillEnabled";
      readonly skillName: string;
      readonly enabled: boolean;
      readonly locationUri?: string;
    }
  | { readonly kind: "deleteSkill"; readonly skillName: string; readonly locationUri?: string }
  | {
      readonly kind: "createMcpServer";
      readonly name: string;
      readonly config: Record<string, unknown>;
      readonly enabled?: boolean;
    }
  | { readonly kind: "updateMcpServer"; readonly name: string; readonly config: Record<string, unknown> }
  | { readonly kind: "deleteMcpServer"; readonly name: string }
  | { readonly kind: "setMcpServerEnabled"; readonly name: string; readonly enabled: boolean }
  | { readonly kind: "testMcpServer"; readonly name: string }
  | {
      readonly kind: "createAgent";
      readonly name: string;
      readonly displayName?: string;
      readonly description?: string;
      readonly systemPrompt?: string;
      readonly initialDefinition?: WebuiPluginAgentDefinition;
    }
  | {
      readonly kind: "updateAgent";
      readonly name: string;
      readonly displayName?: string;
      readonly description?: string;
      readonly systemPrompt?: string;
    }
  | { readonly kind: "deleteAgent"; readonly name: string };

export interface WebuiPluginActions {
  /** True when the runtime exposes plugin management at all. */
  readonly available: boolean;
  /** Every action, checked at the call site. */
  readonly invoke: <K extends WebuiPluginManagementAction>(
    action: K,
    input?: WebuiPluginActionInputs[K],
  ) => Promise<unknown>;
}

/**
 * Build the adapter over a port.
 *
 * A missing port is reported as a rejected promise rather than a throw, so every
 * call site keeps one error path; the message is the one the owner already used
 * for this condition.
 */
export function createWebuiPluginActions(port: {
  readonly pluginManagement?: WebuiPluginPort;
}): WebuiPluginActions {
  return {
    available: port.pluginManagement !== undefined,
    invoke: <K extends WebuiPluginManagementAction>(
      action: K,
      input?: WebuiPluginActionInputs[K],
    ): Promise<unknown> => {
      const send = port.pluginManagement;
      if (!send) return Promise.reject(new Error(WEBUI_PLUGIN_NOT_CONNECTED));
      // The cast is now the only one in the path, and it cannot be reached with
      // a bad action name: `action` is `K extends WebuiPluginManagementAction`.
      // The input is widened because the envelope's `input` is an open record on
      // the wire; its fields were checked against the validator above.
      return send({
        action,
        ...(input === undefined ? {} : { input: input as Record<string, unknown> }),
      });
    },
  };
}

/** Read one action's rows, tolerating the runtime's several list spellings. */
export function webuiPluginRows(
  result: unknown,
  key: string,
): readonly WebuiPluginRow[] {
  const fromValue = (value: unknown): readonly WebuiPluginRow[] =>
    Array.isArray(value)
      ? value.filter(
          (item): item is WebuiPluginRow => !!item && typeof item === "object",
        )
      : [];
  if (Array.isArray(result)) return fromValue(result);
  if (result && typeof result === "object") {
    const found = (result as Record<string, unknown>)[key];
    if (Array.isArray(found)) return fromValue(found);
  }
  return [];
}
