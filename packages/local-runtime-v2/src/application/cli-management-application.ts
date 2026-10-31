import type { LocalAgentRuntimeManagementPort } from "@mavis/local-runtime";

import type { CanvasService } from "../service/canvas/contracts.js";
import type { McpSettingsService } from "../service/mcp/contracts.js";
import { readWorkspaceFile } from "../service/workspace/operations/workspace-path.js";
import type { LocalRuntimeApplication } from "./session/process-local-application-contract.js";

export type CliPluginManagementAction =
  | "listApps"
  | "listMarketplacePlugins"
  | "listInstalledPlugins"
  | "previewGithubPlugin"
  | "importGithubPlugin"
  | "installPlugin"
  | "uninstallPlugin"
  | "enablePlugin"
  | "disablePlugin"
  | "listRuntimeSkills"
  | "listManageableSkills"
  | "setSkillEnabled"
  | "deleteSkill"
  | "listSkillHub"
  | "installSkill"
  | "createSkill"
  | "listMcpServers"
  | "getMcpServer"
  | "createMcpServer"
  | "updateMcpServer"
  | "deleteMcpServer"
  | "setMcpServerEnabled"
  | "testMcpServer"
  | "listAgents"
  | "readAgentAvatar"
  | "getAgent"
  | "createAgent"
  | "updateAgent"
  | "deleteAgent";

export interface CliPluginManagementRequest {
  readonly action: CliPluginManagementAction;
  readonly input?: Record<string, unknown>;
}

export interface CliManagementApplication {
  pluginManagement(request: CliPluginManagementRequest): Promise<unknown>;
  readWorkspaceFile(input: {
    workspaceDir: string;
    path: string;
  }): ReturnType<typeof readWorkspaceFile>;
  readCanvas(input: { sessionId: string }): ReturnType<CanvasService["read"]>;
  applyCanvas(
    input: Parameters<CanvasService["apply"]>[0],
  ): ReturnType<CanvasService["apply"]>;
}

export function createCliManagementApplication(options: {
  readonly application: LocalRuntimeApplication;
  readonly canvas: CanvasService;
  readonly mcp: McpSettingsService;
  readonly agentManagementPort?: LocalAgentRuntimeManagementPort;
}): CliManagementApplication {
  return {
    pluginManagement: (request) => pluginManagement(options, request),
    readWorkspaceFile: ({ workspaceDir, path }) =>
      readWorkspaceFile(workspaceDir, path),
    readCanvas: (input) => options.canvas.read(input),
    applyCanvas: (input) => options.canvas.apply(input),
  };
}

type FieldKind = "string" | "number" | "boolean" | "object";
interface InputShape {
  readonly required?: Readonly<Record<string, FieldKind>>;
  readonly optional?: Readonly<Record<string, FieldKind>>;
}

const queryFields = {
  limit: "number",
  offset: "number",
  keyword: "string",
} as const;
const inputShapes: Readonly<Record<CliPluginManagementAction, InputShape>> = {
  listApps: {},
  listMarketplacePlugins: {
    optional: {
      ...queryFields,
      cursor: "string",
      source: "number",
      category: "number",
      skillCursor: "string",
      skillLimit: "number",
      skillSourceType: "number",
      skillSortType: "number",
    },
  },
  listInstalledPlugins: { optional: queryFields },
  previewGithubPlugin: { required: { url: "string" } },
  importGithubPlugin: {
    optional: {
      source: "object",
      repositoryUrl: "string",
      commitSha: "string",
      subPath: "string",
    },
  },
  installPlugin: {
    required: { pluginName: "string" },
    optional: { source: "number" },
  },
  uninstallPlugin: {
    required: { pluginName: "string" },
    optional: { source: "number" },
  },
  enablePlugin: {
    required: { pluginName: "string" },
    optional: { source: "number" },
  },
  disablePlugin: {
    required: { pluginName: "string" },
    optional: { source: "number" },
  },
  listRuntimeSkills: {
    optional: {
      agentName: "string",
      sessionId: "string",
      workspaceDir: "string",
      includePluginSkills: "boolean",
    },
  },
  listManageableSkills: {
    optional: {
      limit: "number",
      cursor: "string",
      keyword: "string",
      excludeBuiltin: "boolean",
    },
  },
  setSkillEnabled: {
    required: { skillName: "string", enabled: "boolean" },
    optional: { locationUri: "string" },
  },
  deleteSkill: {
    required: { skillName: "string" },
    optional: { locationUri: "string" },
  },
  listSkillHub: {
    optional: {
      limit: "number",
      keyword: "string",
      cursor: "string",
      sourceType: "number",
      sortType: "number",
    },
  },
  installSkill: {
    required: { url: "string" },
    optional: {
      agentName: "string",
      isFromGit: "boolean",
      displayName: "string",
      publisherSourceType: "number",
      creatorInfo: "object",
    },
  },
  createSkill: {
    required: { name: "string", description: "string", content: "string" },
  },
  listMcpServers: { optional: { keyword: "string" } },
  getMcpServer: { required: { name: "string" } },
  createMcpServer: {
    required: { name: "string", config: "object" },
    optional: { enabled: "boolean" },
  },
  updateMcpServer: { required: { name: "string", config: "object" } },
  deleteMcpServer: { required: { name: "string" } },
  setMcpServerEnabled: { required: { name: "string", enabled: "boolean" } },
  testMcpServer: { required: { name: "string" } },
  listAgents: {
    optional: {
      limit: "number",
      offset: "number",
      search: "string",
      include: "string",
    },
  },
  readAgentAvatar: { required: { name: "string" } },
  getAgent: { required: { name: "string" } },
  createAgent: {
    required: { name: "string" },
    optional: {
      displayName: "string",
      description: "string",
      systemPrompt: "string",
      initialDefinition: "object",
    },
  },
  updateAgent: {
    required: { name: "string" },
    optional: {
      displayName: "string",
      description: "string",
      persona: "string",
      systemPrompt: "string",
    },
  },
  deleteAgent: { required: { name: "string" } },
};

async function pluginManagement(
  options: Parameters<typeof createCliManagementApplication>[0],
  request: CliPluginManagementRequest,
): Promise<unknown> {
  const input = validateRequest(request);
  const required = (key: string): string => input[key] as string;
  switch (request.action) {
    case "listApps":
      return (
        options.application.miniApps?.list() ??
        Promise.resolve({ miniApps: [] })
      );
    case "listMarketplacePlugins":
      return options.application.plugins.listMarketplacePlugins(
        input as Parameters<
          LocalRuntimeApplication["plugins"]["listMarketplacePlugins"]
        >[0],
      );
    case "listInstalledPlugins":
      return options.application.plugins.listInstalledPlugins(
        input as Parameters<
          LocalRuntimeApplication["plugins"]["listInstalledPlugins"]
        >[0],
      );
    case "previewGithubPlugin":
      return options.application.plugins.previewGithubPlugin({
        url: required("url"),
      });
    case "importGithubPlugin": {
      const source = input.source;
      if (isRecord(source)) {
        return options.application.plugins.importGithubPlugin({
          source: {
            repositoryUrl:
              typeof source.repositoryUrl === "string"
                ? source.repositoryUrl
                : required("repositoryUrl"),
            commitSha:
              typeof source.commitSha === "string"
                ? source.commitSha
                : required("commitSha"),
            ...(typeof source.subPath === "string"
              ? { subPath: source.subPath }
              : typeof input.subPath === "string"
                ? { subPath: input.subPath }
                : {}),
          },
        });
      }
      return options.application.plugins.importGithubPlugin({
        source: {
          repositoryUrl: required("repositoryUrl"),
          commitSha: required("commitSha"),
          ...(typeof input.subPath === "string"
            ? { subPath: input.subPath }
            : {}),
        },
      });
    }
    case "installPlugin":
      return options.application.plugins.installPlugin({
        pluginName: required("pluginName"),
        ...(pluginSource(input) !== undefined
          ? { source: pluginSource(input) }
          : {}),
      });
    case "uninstallPlugin":
      return options.application.plugins.uninstallPlugin({
        pluginName: required("pluginName"),
        ...(pluginSource(input) !== undefined
          ? { source: pluginSource(input) }
          : {}),
      });
    case "enablePlugin":
      return options.application.plugins.enablePlugin({
        pluginName: required("pluginName"),
        ...(pluginSource(input) !== undefined
          ? { source: pluginSource(input) }
          : {}),
      });
    case "disablePlugin":
      return options.application.plugins.disablePlugin({
        pluginName: required("pluginName"),
        ...(pluginSource(input) !== undefined
          ? { source: pluginSource(input) }
          : {}),
      });
    case "listRuntimeSkills":
      return options.application.skills.listRuntimeSkills(
        input as Parameters<
          LocalRuntimeApplication["skills"]["listRuntimeSkills"]
        >[0],
      );
    case "listManageableSkills":
      return options.application.skills.listSkills(
        input as Parameters<LocalRuntimeApplication["skills"]["listSkills"]>[0],
      );
    case "setSkillEnabled":
      return options.application.skills.setSkillEnabled(
        {
          skillName: required("skillName"),
          ...(typeof input.locationUri === "string"
            ? { locationUri: input.locationUri }
            : {}),
        },
        input.enabled as boolean,
      );
    case "deleteSkill":
      return options.application.skills.deleteSkill({
        skillName: required("skillName"),
        ...(typeof input.locationUri === "string"
          ? { locationUri: input.locationUri }
          : {}),
      });
    case "listSkillHub":
      return options.application.skills.listSkillHub(
        input as Parameters<
          LocalRuntimeApplication["skills"]["listSkillHub"]
        >[0],
      );
    case "installSkill":
      return options.application.skills.installSkill(
        input as Parameters<
          LocalRuntimeApplication["skills"]["installSkill"]
        >[0],
      );
    case "createSkill":
      return options.application.skills.createSkill({
        name: required("name"),
        description: required("description"),
        content: required("content"),
        ...(typeof input.agentName === "string"
          ? { agentName: input.agentName }
          : {}),
      });
    case "listMcpServers":
      return options.mcp
        .list(typeof input.keyword === "string" ? input.keyword : undefined)
        .then((servers) => ({ servers }));
    case "getMcpServer":
      return options.mcp.get(required("name"));
    case "createMcpServer":
      return options.mcp.create(
        required("name"),
        input.config as Parameters<McpSettingsService["create"]>[1],
        input.enabled !== false,
      );
    case "updateMcpServer":
      return options.mcp.update(
        required("name"),
        input.config as Parameters<McpSettingsService["update"]>[1],
      );
    case "deleteMcpServer":
      return options.mcp.delete(required("name"));
    case "setMcpServerEnabled":
      return options.mcp.setEnabled(required("name"), input.enabled as boolean);
    case "testMcpServer":
      return options.mcp.test(required("name"));
    case "listAgents":
      return requireAgentManagement(options).listAgents(
        input as Parameters<LocalAgentRuntimeManagementPort["listAgents"]>[0],
      );
    case "readAgentAvatar": {
      const avatar = await requireAgentManagement(options).readCustomAgentAvatar(
        required("name"),
      );
      return avatar
        ? {
            avatarDataUrl: `data:${avatar.contentType};base64,${Buffer.from(avatar.bytes).toString("base64")}`,
          }
        : {};
    }
    case "getAgent":
      return requireAgentManagement(options).getAgent({
        name: required("name"),
      });
    case "createAgent":
      return requireAgentManagement(options).createAgent(
        input as Parameters<LocalAgentRuntimeManagementPort["createAgent"]>[0],
      );
    case "updateAgent":
      return requireAgentManagement(options).updateAgent({
        name: required("name"),
        ...(typeof input.displayName === "string"
          ? { displayName: input.displayName }
          : {}),
        ...(typeof input.description === "string"
          ? { description: input.description }
          : {}),
        ...(typeof input.persona === "string"
          ? { persona: input.persona }
          : {}),
        ...(typeof input.systemPrompt === "string"
          ? { systemPrompt: input.systemPrompt }
          : {}),
      });
    case "deleteAgent":
      return requireAgentManagement(options).deleteAgent({
        name: required("name"),
      });
  }
}

function validateRequest(
  request: CliPluginManagementRequest,
): Record<string, unknown> {
  if (!request || !Object.hasOwn(inputShapes, request.action)) {
    throw new Error("Unsupported plugin management action.");
  }
  const input = request.input ?? {};
  if (!isRecord(input))
    throw new Error("Plugin management input must be an object.");
  const shape = inputShapes[request.action];
  const allowed = { ...shape.required, ...shape.optional } as Record<
    string,
    FieldKind
  >;
  for (const [key, value] of Object.entries(input)) {
    const kind = allowed[key];
    if (
      !kind ||
      (kind === "object" ? !isRecord(value) : typeof value !== kind)
    ) {
      throw new Error(
        `Plugin management input is invalid for ${request.action}.`,
      );
    }
  }
  for (const [key, kind] of Object.entries(shape.required ?? {})) {
    const value = input[key];
    if (
      !(key in input) ||
      (kind === "object" ? !isRecord(value) : typeof value !== kind) ||
      (kind === "string" && !(value as string).trim())
    ) {
      throw new Error(`Plugin management input is missing ${key}.`);
    }
  }
  if (request.action === "importGithubPlugin" && !validGithubSource(input)) {
    throw new Error(
      "Plugin management input is invalid for importGithubPlugin.",
    );
  }
  if (
    (request.action === "createMcpServer" ||
      request.action === "updateMcpServer") &&
    !isMcpServerConfig(input.config)
  ) {
    throw new Error(
      `Plugin management input is invalid for ${request.action}.`,
    );
  }
  if (
    request.action === "createAgent" &&
    input.initialDefinition !== undefined &&
    !isAgentDefinition(input.initialDefinition)
  ) {
    throw new Error("Plugin management input is invalid for createAgent.");
  }
  if (
    [
      "installPlugin",
      "uninstallPlugin",
      "enablePlugin",
      "disablePlugin",
    ].includes(request.action) &&
    input.source !== undefined &&
    input.source !== 1 &&
    input.source !== 2
  ) {
    throw new Error(
      `Plugin management input is invalid for ${request.action}.`,
    );
  }
  return input;
}

function validGithubSource(input: Record<string, unknown>): boolean {
  const source = input.source;
  const sourceRecord = isRecord(source) ? source : {};
  const repositoryUrl =
    typeof sourceRecord.repositoryUrl === "string"
      ? sourceRecord.repositoryUrl
      : input.repositoryUrl;
  const commitSha =
    typeof sourceRecord.commitSha === "string"
      ? sourceRecord.commitSha
      : input.commitSha;
  const subPath = sourceRecord.subPath ?? input.subPath;
  return (
    typeof repositoryUrl === "string" &&
    !!repositoryUrl.trim() &&
    typeof commitSha === "string" &&
    !!commitSha.trim() &&
    (subPath === undefined || typeof subPath === "string")
  );
}

function pluginSource(
  input: Record<string, unknown>,
): Parameters<
  LocalRuntimeApplication["plugins"]["installPlugin"]
>[0]["source"] {
  if (input.source === 1 || input.source === 2) return input.source;
  return undefined;
}

function isMcpServerConfig(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (value.description !== undefined && typeof value.description !== "string")
    return false;
  if (value.timeoutMs !== undefined && typeof value.timeoutMs !== "number")
    return false;
  if (value.env !== undefined && !isStringRecord(value.env)) return false;
  if (value.headers !== undefined && !isStringRecord(value.headers))
    return false;
  if (
    value.args !== undefined &&
    (!Array.isArray(value.args) ||
      value.args.some((item) => typeof item !== "string"))
  )
    return false;
  if (value.transport === "stdio")
    return typeof value.command === "string" && !!value.command.trim();
  return (
    ["http", "streamable-http", "sse"].includes(String(value.transport)) &&
    typeof value.url === "string" &&
    !!value.url.trim()
  );
}

function isAgentDefinition(value: unknown): boolean {
  if (!isRecord(value)) return false;
  const allowed = new Set([
    "name",
    "description",
    "systemPrompt",
    "model",
    "effort",
    "tools",
    "disallowedTools",
    "mcpServers",
    "skills",
    "mavis",
  ]);
  if (Object.keys(value).some((key) => !allowed.has(key))) return false;
  if (
    typeof value.name !== "string" ||
    typeof value.description !== "string" ||
    typeof value.systemPrompt !== "string"
  )
    return false;
  if (
    ["model", "effort"].some(
      (key) => value[key] !== undefined && typeof value[key] !== "string",
    )
  )
    return false;
  if (
    ["tools", "disallowedTools", "mcpServers", "skills"].some(
      (key) => value[key] !== undefined && !isStringArray(value[key]),
    )
  )
    return false;
  if (value.mavis !== undefined) {
    if (!isRecord(value.mavis)) return false;
    const mavis = value.mavis;
    const allowedMavis = new Set([
      "displayName",
      "avatar",
      "contextWindow",
      "maxOutputTokens",
      "defaultWorkspaceDir",
      "extensionSkills",
    ]);
    if (Object.keys(mavis).some((key) => !allowedMavis.has(key))) return false;
    if (
      ["displayName", "avatar", "defaultWorkspaceDir"].some(
        (key) => mavis[key] !== undefined && typeof mavis[key] !== "string",
      )
    )
      return false;
    if (
      ["contextWindow", "maxOutputTokens"].some(
        (key) => mavis[key] !== undefined && typeof mavis[key] !== "number",
      )
    )
      return false;
    if (
      mavis.extensionSkills !== undefined &&
      !isStringArray(mavis.extensionSkills)
    )
      return false;
  }
  return true;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return (
    isRecord(value) &&
    Object.values(value).every((item) => typeof item === "string")
  );
}

function isStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) && value.every((item) => typeof item === "string")
  );
}

function requireAgentManagement(options: {
  readonly agentManagementPort?: LocalAgentRuntimeManagementPort;
}): LocalAgentRuntimeManagementPort {
  if (!options.agentManagementPort)
    throw new Error("Agent management is unavailable in this runtime.");
  return options.agentManagementPort;
}
