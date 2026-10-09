// Permission mode, instructions, memory and the user profile.
//
// Split out of the former `server/host.ts` `createHarnessPortFromHost`; the
// bodies are unchanged, only the module boundary moved.
import {
  readAgentMemory,
  readGlobalInstructions,
  readUserProfile,
  writeAgentMemory,
  writeGlobalInstructions,
  writeUserProfile,
  WEBUI_DEFAULT_AGENT_NAME,
} from "../profile-files.js";
import type { WebuiHarnessPort } from "../../server/port.js";
import type { WebuiRuntimeHostHandle } from "./host-contract.js";
import {
  requireCliService,
  requireDataDir,
  requireMemorySettings,
} from "./requirements.js";

export function createSettingsAdapter(
  host: WebuiRuntimeHostHandle,
): Pick<WebuiHarnessPort, "getPermissionMode" | "setPermissionMode" | "getGlobalInstructions" | "setGlobalInstructions" | "getAgentMemory" | "setAgentMemory" | "getUserProfile" | "setUserProfile" | "getMemorySettings" | "setMemorySettings"> {
  return {
    async getPermissionMode() {
      return requireCliService(host).getPermissionMode();
    },

    async setPermissionMode(request) {
      return requireCliService(host).setPermissionMode(request);
    },

    async getGlobalInstructions() {
      return readGlobalInstructions(requireDataDir(host));
    },

    async setGlobalInstructions(request) {
      return writeGlobalInstructions(requireDataDir(host), request.content);
    },

    async getAgentMemory(request) {
      return readAgentMemory(
        requireDataDir(host),
        WEBUI_DEFAULT_AGENT_NAME,
        { includeContent: request?.includeContent === true },
      );
    },

    async setAgentMemory(request) {
      return writeAgentMemory(
        requireDataDir(host),
        WEBUI_DEFAULT_AGENT_NAME,
        request.content,
      );
    },

    async getUserProfile() {
      return readUserProfile(requireDataDir(host));
    },

    async setUserProfile(request) {
      return writeUserProfile(requireDataDir(host), {
        nickname: request.nickname,
        occupation: request.occupation,
        moreAbout: request.moreAbout,
      });
    },

    async getMemorySettings() {
      return requireMemorySettings(host).get();
    },

    async setMemorySettings(request) {
      return requireMemorySettings(host).set(request);
    },
  };
}
