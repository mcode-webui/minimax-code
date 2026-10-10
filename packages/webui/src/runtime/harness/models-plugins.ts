// Models, providers, skills and plugin management.
//
// Split out of the former `server/host.ts` `createHarnessPortFromHost`; the
// bodies are unchanged, only the module boundary moved.
import type { WebuiHarnessPort } from "../port.js";
import type { WebuiRuntimeHostHandle } from "./host-contract.js";
import { requireCliService } from "./requirements.js";

export function createModelsPluginsAdapter(
  host: WebuiRuntimeHostHandle,
): Pick<WebuiHarnessPort, "listModels" | "selectModel" | "listSkills" | "pluginManagement" | "listUserModelProviders" | "createUserModelProvider" | "updateUserModelProvider" | "deleteUserModelProvider" | "testUserModelProvider" | "testUserModel" | "discoverUserModelsCandidate" | "saveUserModelProviderCandidate" | "listProviderPresets" | "getMiniMaxApiKeyStatus" | "upsertMiniMaxApiKey" | "getCodexOAuthStatus" | "getMiniMaxModelSource" | "setMiniMaxModelSource" | "testUserModelCandidate" | "revealModelProviderApiKey" | "startCodexOAuthLogin" | "cancelCodexOAuthLogin" | "refreshModels"> {
  return {
    async listModels(request) {
      return requireCliService(host).listModels(request);
    },

    async selectModel(request) {
      return requireCliService(host).selectModel(request);
    },

    async listSkills(request) {
      // cliService.listSkills returns the full `SkillInfo[]` shape; map it
      // down to the WebUI's minimal projection. `displayDescription` and
      // i18n keys win over the raw `description` so the popover matches the
      // desktop's translated copy.
      const result = await requireCliService(host).listSkills(request ?? {});
      return {
        skills: result.skills.map((skill) => ({
          name: skill.name,
          displayName: skill.displayName ?? skill.name,
          description:
            skill.displayDescription ?? skill.description ?? "",
        })),
      };
    },

    async pluginManagement(request) {
      return requireCliService(host).pluginManagement(request);
    },

    async listUserModelProviders() {
      return requireCliService(host).listUserModelProviders();
    },

    async createUserModelProvider(request) {
      return requireCliService(host).createUserModelProvider(request);
    },

    async updateUserModelProvider(request) {
      return requireCliService(host).updateUserModelProvider(request);
    },

    async deleteUserModelProvider(providerId) {
      return requireCliService(host).deleteUserModelProvider({ providerId });
    },

    async testUserModelProvider(request) {
      return requireCliService(host).testUserModelProvider(request);
    },

    async testUserModel(request) {
      return requireCliService(host).testUserModel({ providerId: request.providerId, modelId: request.modelId });
    },

    async discoverUserModelsCandidate(request) {
      return requireCliService(host).discoverUserModelsCandidate(request);
    },

    async saveUserModelProviderCandidate(request) {
      return requireCliService(host).saveUserModelProviderCandidate(request);
    },

    async listProviderPresets() {
      return requireCliService(host).listProviderPresets();
    },

    async getMiniMaxApiKeyStatus() {
      return requireCliService(host).getMiniMaxApiKeyStatus();
    },

    async upsertMiniMaxApiKey(request) {
      return requireCliService(host).upsertMiniMaxApiKey(request);
    },

    async getCodexOAuthStatus() {
      return requireCliService(host).getCodexOAuthStatus();
    },

    async getMiniMaxModelSource() { return requireCliService(host).getMiniMaxModelSource(); },

    async setMiniMaxModelSource(request) { return requireCliService(host).setMiniMaxModelSource(request); },

    async testUserModelCandidate(request) {
      // The wire validator's contract is `Record<string, unknown>` only. Keep
      // the historical field reads here: missing keys become `undefined` and
      // malformed values reach the same harness validation path as before.
      return requireCliService(host).testUserModelCandidate({
        candidate: request.candidate as Record<string, unknown>,
        modelId: request.modelId as string,
      });
    },

    async revealModelProviderApiKey(request) { return requireCliService(host).revealModelProviderApiKey(request); },

    async startCodexOAuthLogin(request) { return requireCliService(host).startCodexOAuthLogin(request); },

    async cancelCodexOAuthLogin(request) { return requireCliService(host).cancelCodexOAuthLogin(request); },

    async refreshModels() { return requireCliService(host).refreshModels(); },
  };
}
