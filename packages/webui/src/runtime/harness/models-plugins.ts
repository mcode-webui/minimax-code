// Models, providers, skills and plugin management.
//
// Split out of the former `server/host.ts` `createHarnessPortFromHost`; the
// bodies are unchanged, only the module boundary moved.
import type { WebuiHarnessPort } from "../port.js";
import type { WebuiRuntimeHostHandle } from "./host-contract.js";
import {
  toRuntimeCreateProviderRequest,
  toRuntimeDiscoverCandidateRequest,
  toRuntimeSaveCandidateRequest,
  toRuntimeUpdateProviderRequest,
  toRuntimeTestCandidateRequest,
} from "./provider-input.js";
import { requireCliService } from "./requirements.js";
import {
  toWebuiModelEntries,
  toWebuiRecord,
  toWebuiRecordList,
} from "./result-conversion.js";

export function createModelsPluginsAdapter(
  host: WebuiRuntimeHostHandle,
): Pick<
  WebuiHarnessPort,
  | "listModels"
  | "selectModel"
  | "listSkills"
  | "pluginManagement"
  | "listUserModelProviders"
  | "createUserModelProvider"
  | "updateUserModelProvider"
  | "deleteUserModelProvider"
  | "testUserModelProvider"
  | "testUserModel"
  | "discoverUserModelsCandidate"
  | "saveUserModelProviderCandidate"
  | "listProviderPresets"
  | "getMiniMaxApiKeyStatus"
  | "upsertMiniMaxApiKey"
  | "getCodexOAuthStatus"
  | "getMiniMaxModelSource"
  | "setMiniMaxModelSource"
  | "testUserModelCandidate"
  | "revealModelProviderApiKey"
  | "startCodexOAuthLogin"
  | "cancelCodexOAuthLogin"
  | "refreshModels"
> {
  return {
    async listModels(request) {
      // Converted: the runtime lists untyped entries, and the wire's entry has
      // two fields that make an entry selectable at all. A row without them is
      // dropped here rather than rendered and failing when clicked.
      return toWebuiModelEntries(
        await requireCliService(host).listModels(request),
      );
    },

    async selectModel(request) {
      // The runtime's verdict is a boolean: the application contract is
      // `models.select(input): Promise<boolean>` (`process-local-application-contract.ts:293`).
      // The wire declares `{ success?: boolean }` and the client reads
      // `answer?.success === false` to tell a refused selection from one that
      // landed (`models-workflows.ts:258`), so forwarding the boolean raw left
      // that guard unable to fire — it compares `undefined` to `false`.
      const success = await requireCliService(host).selectModel(request);
      return { success };
    },

    async listSkills(request) {
      // cliService.listSkills returns the full `SkillInfo[]` shape; map it
      // down to the WebUI's minimal projection. `displayDescription` and
      // i18n keys win over the raw `description` so the popover shows the
      // translated copy.
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
      return requireCliService(host).createUserModelProvider(
        toRuntimeCreateProviderRequest(request),
      );
    },

    async updateUserModelProvider(request) {
      return requireCliService(host).updateUserModelProvider(
        toRuntimeUpdateProviderRequest(request),
      );
    },

    async deleteUserModelProvider(providerId) {
      return requireCliService(host).deleteUserModelProvider({ providerId });
    },

    async testUserModelProvider(request) {
      return requireCliService(host).testUserModelProvider(request);
    },

    async testUserModel(request) {
      return requireCliService(host).testUserModel({
        providerId: request.providerId,
        modelId: request.modelId,
      });
    },

    async discoverUserModelsCandidate(request) {
      return requireCliService(host).discoverUserModelsCandidate(
        toRuntimeDiscoverCandidateRequest(request),
      );
    },

    async saveUserModelProviderCandidate(request) {
      return requireCliService(host).saveUserModelProviderCandidate(
        toRuntimeSaveCandidateRequest(request),
      );
    },

    async listProviderPresets() {
      return toWebuiRecordList(
        await requireCliService(host).listProviderPresets(),
      );
    },

    async getMiniMaxApiKeyStatus() {
      return requireCliService(host).getMiniMaxApiKeyStatus();
    },

    async upsertMiniMaxApiKey(request) {
      return requireCliService(host).upsertMiniMaxApiKey(request);
    },

    async getCodexOAuthStatus() {
      return toWebuiRecord(await requireCliService(host).getCodexOAuthStatus());
    },

    async getMiniMaxModelSource() { return requireCliService(host).getMiniMaxModelSource(); },

    async setMiniMaxModelSource(request) { return requireCliService(host).setMiniMaxModelSource(request); },

    async testUserModelCandidate(request) {
      // The wire validator accepts an open record, so `baseUrl` — the endpoint
      // the test is actually made against — can be missing by the time it
      // arrives. It is required now, at this boundary, because a candidate with
      // no endpoint used to type-check all the way down and then fail inside the
      // runtime with nothing to say which request was at fault.
      return requireCliService(host).testUserModelCandidate(
        toRuntimeTestCandidateRequest(request),
      );
    },

    async revealModelProviderApiKey(request) {
      // Synchronous on the runtime; the port is asynchronous. Wrapped here so a
      // caller of the port still awaits, and so the mirror records the runtime's
      // real shape instead of a promise it never produces.
      return Promise.resolve(
        requireCliService(host).revealModelProviderApiKey(request),
      );
    },

    async startCodexOAuthLogin(request) { return requireCliService(host).startCodexOAuthLogin(request); },

    async cancelCodexOAuthLogin(request) {
      return requireCliService(host).cancelCodexOAuthLogin(request.loginId);
    },

    async refreshModels() { return requireCliService(host).refreshModels(); },
  };
}
