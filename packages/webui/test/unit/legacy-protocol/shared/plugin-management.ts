export type WebuiPluginManagementAction =
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

export interface WebuiPluginManagementRequest {
  readonly action: WebuiPluginManagementAction;
  readonly input?: Record<string, unknown>;
}
