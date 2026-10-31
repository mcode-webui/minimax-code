// Models capability port.
//
// The model catalogue, the selection command and the provider CRUD. The provider
// CRUD is this port's duty rather than `settings`' — `upsertMiniMaxApiKey`
// included, even though the *status* read beside it stays with `settings`.
//
// Every method stays optional — `undefined` means "the operation is not wired".

import type {
  WebuiCreateUserModelProviderRequest,
  WebuiDiscoverUserModelsCandidateRequest,
  WebuiModelEntry,
  WebuiModelProviderView,
  WebuiSaveUserModelProviderCandidateRequest,
  WebuiTestUserModelCandidateRequest,
  WebuiUpdateUserModelProviderRequest,
} from "../../../../shared/contracts/models.js";
import type { WebuiModelSelectionRequest } from "./model-view.js";

export interface ModelsPort {
  readonly listModels?: (request?: {
    readonly sessionId?: string;
  }) => Promise<readonly WebuiModelEntry[]>;
  readonly selectModel?: (
    request: WebuiModelSelectionRequest,
  ) => Promise<{ readonly success?: boolean }>;
  readonly listUserModelProviders?: () => Promise<readonly WebuiModelProviderView[]>;
  readonly createUserModelProvider?: (
    request: WebuiCreateUserModelProviderRequest,
  ) => Promise<unknown>;
  readonly updateUserModelProvider?: (
    request: WebuiUpdateUserModelProviderRequest,
  ) => Promise<unknown>;
  readonly deleteUserModelProvider?: (providerId: string) => Promise<unknown>;
  readonly testUserModelProvider?: (request: { readonly providerId: string; readonly apiKey?: string }) => Promise<unknown>;
  readonly testUserModel?: (request: {
    readonly providerId: string;
    readonly modelId: string;
  }) => Promise<unknown>;
  readonly discoverUserModelsCandidate?: (
    request: WebuiDiscoverUserModelsCandidateRequest,
  ) => Promise<unknown>;
  readonly saveUserModelProviderCandidate?: (
    request: WebuiSaveUserModelProviderCandidateRequest,
  ) => Promise<unknown>;
  readonly listProviderPresets?: () => Promise<readonly Record<string, unknown>[]>;
  readonly upsertMiniMaxApiKey?: (request: {
    readonly apiKey: string;
    readonly saveAndUse?: boolean;
  }) => Promise<unknown>;
  readonly testUserModelCandidate?: (
    request: WebuiTestUserModelCandidateRequest,
  ) => Promise<unknown>;
  readonly revealModelProviderApiKey?: (request: { readonly providerId: string }) => Promise<string>;
  readonly refreshModels?: () => Promise<unknown>;
}
