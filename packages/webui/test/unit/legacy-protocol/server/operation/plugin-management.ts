import { WebuiErrorCode } from "../envelope.js";
import type {
  WebuiPluginManagementAction,
  WebuiPluginManagementRequest,
} from "../port.js";
import type { WebuiOperation } from "./operation-contract.js";
import { PLUGIN_MANAGEMENT_OPERATION_NAME } from "./names.js";

const ACTIONS = new Set<WebuiPluginManagementRequest["action"]>([
  "listApps",
  "previewGithubPlugin",
  "importGithubPlugin",
  "listMarketplacePlugins",
  "listInstalledPlugins",
  "installPlugin",
  "uninstallPlugin",
  "enablePlugin",
  "disablePlugin",
  "listRuntimeSkills",
  "listManageableSkills",
  "setSkillEnabled",
  "deleteSkill",
  "listSkillHub",
  "installSkill",
  "createSkill",
  "listMcpServers",
  "getMcpServer",
  "createMcpServer",
  "updateMcpServer",
  "deleteMcpServer",
  "setMcpServerEnabled",
  "testMcpServer",
  "listAgents",
  "readAgentAvatar",
  "getAgent",
  "createAgent",
  "updateAgent",
  "deleteAgent",
]);

type FieldKind = "string" | "number" | "boolean" | "object" | "array";
interface InputShape {
  readonly required?: Readonly<Record<string, FieldKind>>;
  readonly optional?: Readonly<Record<string, FieldKind>>;
}

const queryFields = {
  limit: "number",
  offset: "number",
  keyword: "string",
} as const;
const INPUT_SHAPES: Readonly<Record<WebuiPluginManagementAction, InputShape>> =
  {
    listApps: {},
    previewGithubPlugin: { required: { url: "string" } },
    importGithubPlugin: { required: { source: "object" } },
    listMarketplacePlugins: {
      optional: {
        ...queryFields,
        source: "number",
        category: "number",
        skillLimit: "number",
      },
    },
    listInstalledPlugins: { optional: queryFields },
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
        systemPrompt: "string",
      },
    },
    deleteAgent: { required: { name: "string" } },
  };

function matchesField(value: unknown, kind: FieldKind): boolean {
  if (kind === "array") return Array.isArray(value);
  if (kind === "object")
    return value !== null && typeof value === "object" && !Array.isArray(value);
  return typeof value === kind;
}

function isStringRecord(value: unknown): boolean {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.values(value).every((item) => typeof item === "string")
  );
}

function isStringArray(value: unknown): boolean {
  return (
    Array.isArray(value) && value.every((item) => typeof item === "string")
  );
}

function isAgentDefinition(value: unknown): boolean {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    return false;
  const definition = value as Record<string, unknown>;
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
  if (Object.keys(definition).some((key) => !allowed.has(key))) return false;
  if (
    typeof definition.name !== "string" ||
    typeof definition.description !== "string" ||
    typeof definition.systemPrompt !== "string"
  )
    return false;
  for (const field of ["model", "effort"] as const) {
    if (
      definition[field] !== undefined &&
      typeof definition[field] !== "string"
    )
      return false;
  }
  for (const field of [
    "tools",
    "disallowedTools",
    "mcpServers",
    "skills",
  ] as const) {
    if (definition[field] !== undefined && !isStringArray(definition[field]))
      return false;
  }
  if (definition.mavis !== undefined) {
    if (
      definition.mavis === null ||
      typeof definition.mavis !== "object" ||
      Array.isArray(definition.mavis)
    )
      return false;
    const mavis = definition.mavis as Record<string, unknown>;
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
        (field) =>
          mavis[field] !== undefined && typeof mavis[field] !== "string",
      ) ||
      ["contextWindow", "maxOutputTokens"].some(
        (field) =>
          mavis[field] !== undefined && typeof mavis[field] !== "number",
      ) ||
      (mavis.extensionSkills !== undefined &&
        !isStringArray(mavis.extensionSkills))
    )
      return false;
  }
  return true;
}

function isMcpServerConfig(value: unknown): boolean {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    return false;
  const config = value as Record<string, unknown>;
  if (
    typeof config.description !== "undefined" &&
    typeof config.description !== "string"
  )
    return false;
  if (
    typeof config.timeoutMs !== "undefined" &&
    typeof config.timeoutMs !== "number"
  )
    return false;
  if (typeof config.env !== "undefined" && !isStringRecord(config.env))
    return false;
  if (typeof config.headers !== "undefined" && !isStringRecord(config.headers))
    return false;
  if (
    typeof config.args !== "undefined" &&
    (!Array.isArray(config.args) ||
      config.args.some((arg) => typeof arg !== "string"))
  )
    return false;
  if (config.transport === "stdio")
    return typeof config.command === "string" && !!config.command.trim();
  return (
    (config.transport === "http" ||
      config.transport === "streamable-http" ||
      config.transport === "sse") &&
    typeof config.url === "string" &&
    !!config.url.trim()
  );
}

function isGithubPluginSource(value: unknown): boolean {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    return false;
  const source = value as Record<string, unknown>;
  return (
    typeof source.repositoryUrl === "string" &&
    !!source.repositoryUrl.trim() &&
    typeof source.commitSha === "string" &&
    !!source.commitSha.trim() &&
    (source.subPath === undefined || typeof source.subPath === "string")
  );
}

export const pluginManagementOperation: WebuiOperation<
  WebuiPluginManagementRequest,
  unknown
> = {
  name: PLUGIN_MANAGEMENT_OPERATION_NAME,
  validate: (body) => {
    if (body === null || typeof body !== "object" || Array.isArray(body))
      return {
        ok: false,
        code: WebuiErrorCode.invalidBody,
        message: "pluginManagement body must be an object",
      };
    const value = body as Record<string, unknown>;
    if (
      typeof value.action !== "string" ||
      !ACTIONS.has(value.action as WebuiPluginManagementRequest["action"])
    )
      return {
        ok: false,
        code: WebuiErrorCode.invalidBody,
        message: "pluginManagement action is invalid",
      };
    if (
      value.input !== undefined &&
      (value.input === null ||
        typeof value.input !== "object" ||
        Array.isArray(value.input))
    )
      return {
        ok: false,
        code: WebuiErrorCode.invalidBody,
        message: "pluginManagement input must be an object",
      };
    const action = value.action as WebuiPluginManagementAction;
    const input = (value.input ?? {}) as Record<string, unknown>;
    const shape = INPUT_SHAPES[action];
    const allowedFields: Record<string, FieldKind> = {
      ...shape.required,
      ...shape.optional,
    };
    const invalidField = Object.entries(input).find(([key, field]) => {
      const kind = allowedFields[key];
      return kind === undefined || !matchesField(field, kind);
    });
    const missingField = Object.entries(shape.required ?? {}).find(
      ([key, kind]) =>
        !(key in input) ||
        !matchesField(input[key], kind) ||
        (kind === "string" && !(input[key] as string).trim()),
    );
    const emptyConfig =
      (action === "createMcpServer" || action === "updateMcpServer") &&
      !isMcpServerConfig(input.config);
    const invalidAgentDefinition =
      action === "createAgent" &&
      input.initialDefinition !== undefined &&
      !isAgentDefinition(input.initialDefinition);
    const invalidPluginSource =
      [
        "installPlugin",
        "uninstallPlugin",
        "enablePlugin",
        "disablePlugin",
      ].includes(action) &&
      input.source !== undefined &&
      input.source !== 1 &&
      input.source !== 2;
    const invalidGithubSource =
      action === "importGithubPlugin" && !isGithubPluginSource(input.source);
    if (
      invalidField ||
      missingField ||
      emptyConfig ||
      invalidAgentDefinition ||
      invalidPluginSource ||
      invalidGithubSource
    )
      return {
        ok: false,
        code: WebuiErrorCode.invalidBody,
        message: `pluginManagement input is invalid for ${action}`,
      };
    return {
      ok: true,
      body: {
        action,
        ...(value.input ? { input } : {}),
      },
    };
  },
};
