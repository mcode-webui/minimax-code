import type { V1ServiceCompatibility } from '../../compat/v1/runtime.js';
import { createProcessLocalApplication } from '../index.js';
import { createProcessLocalMiniAppApplication } from './process-local-miniapp-application.js';
import { createProcessLocalMiniAppAgentApplication } from './process-local-miniapp-agent-application.js';
import type { WorkspaceGitService } from '../../service/workspace/index.js';

type ProcessLocalApplicationOptions = Parameters<typeof createProcessLocalApplication>[0];
type ProcessLocalMiniAppArgs = Parameters<typeof createProcessLocalMiniAppApplication>;
type ProcessLocalMiniAppAgentGateway = Parameters<
  typeof createProcessLocalMiniAppAgentApplication
>[0];

/**
 * Wires the process-local Application facade over owners the runtime has already
 * initialized, keeping that wiring out of the services composition root.
 */
export function composeProcessLocalApplication(input: {
  readonly eventBus: ProcessLocalApplicationOptions['eventBus'];
  readonly usageCommits: ProcessLocalApplicationOptions['usageCommits'];
  readonly workspaceGit: Pick<
    WorkspaceGitService,
    | 'getMetadata'
    | 'getChanges'
    | 'getBranches'
    | 'getBranchPicker'
    | 'getDefaultBranch'
    | 'probe'
    | 'listWorktrees'
    | 'checkout'
    | 'getReviewSummary'
    | 'listReviewFileDiffs'
    | 'getReviewFileContent'
    | 'searchReviewDiffs'
  >;
  readonly compatibility: Pick<V1ServiceCompatibility, 'skills' | 'peripherals'>;
  readonly listRuntimeSkills: ProcessLocalApplicationOptions['skills']['listRuntimeSkills'];
  readonly plugins: ProcessLocalApplicationOptions['plugins'];
  readonly pluginControl: ProcessLocalMiniAppArgs[0];
  readonly miniApp: ProcessLocalMiniAppArgs[1];
  readonly miniAppAgent?: ProcessLocalMiniAppAgentGateway;
  readonly planEntryEnabled: () => boolean;
  readonly sessionReports?: ProcessLocalApplicationOptions['sessionReports'];
  readonly instructions?: ProcessLocalApplicationOptions['instructions'];
  readonly mcp: ProcessLocalApplicationOptions['peripherals']['mcp'];
  readonly modelProvider: ProcessLocalApplicationOptions['modelProvider'];
}): ReturnType<typeof createProcessLocalApplication> {
  const application = createProcessLocalApplication({
    eventBus: input.eventBus,
    usageCommits: input.usageCommits,
    skills: {
      listSkills: (request) => input.compatibility.skills.listSkills(request),
      listRuntimeSkills: (request) => input.listRuntimeSkills(request),
      setSkillEnabled: (request, enabled) => input.compatibility.skills.setSkillEnabled(request, enabled),
      deleteSkill: (request) => input.compatibility.skills.deleteSkill(request),
      createSkill: (request) => input.compatibility.skills.createSkill(request),
      getSkill: (request, options) => input.compatibility.skills.getSkill(request, options),
      listSkillHub: (request) => input.compatibility.skills.listSkillHub(request),
      installSkill: (request) => input.compatibility.skills.installSkill(request),
    },
    plugins: input.plugins,
    miniApps: createProcessLocalMiniAppApplication(input.pluginControl, input.miniApp),
    workspace: {
      ...(input.compatibility.peripherals.workspace ?? {}),
      git: {
        ...(input.compatibility.peripherals.workspace?.git ?? {}),
        getMetadata: async (workspaceDir) => ({
          ...(await input.workspaceGit.getMetadata(workspaceDir)),
        }),
        getChanges: async (workspaceDir, mode) => ({
          ...(await input.workspaceGit.getChanges(workspaceDir, mode)),
        }),
        getBranches: async (workspaceDir, includeRemote) => ({
          ...(await input.workspaceGit.getBranches(workspaceDir, includeRemote)),
        }),
        getBranchPicker: async (workspaceDir) => ({
          ...(await input.workspaceGit.getBranchPicker(workspaceDir)),
        }),
        getDefaultBranch: async (workspaceDir) => ({
          ...(await input.workspaceGit.getDefaultBranch(workspaceDir)),
        }),
        probe: async (workspaceDir) => ({ ...(await input.workspaceGit.probe(workspaceDir)) }),
        listWorktrees: async (workspaceDir) => ({ ...(await input.workspaceGit.listWorktrees(workspaceDir)) }),
        checkout: async (workspaceDir, branch) => ({ ...(await input.workspaceGit.checkout(workspaceDir, branch)) }),
        getReviewSummary: input.workspaceGit.getReviewSummary.bind(input.workspaceGit),
        listReviewFileDiffs: input.workspaceGit.listReviewFileDiffs.bind(input.workspaceGit),
        getReviewFileContent: input.workspaceGit.getReviewFileContent.bind(input.workspaceGit),
        searchReviewDiffs: input.workspaceGit.searchReviewDiffs.bind(input.workspaceGit),
      },
    },
    plan: { isEntryEnabled: input.planEntryEnabled },
    ...(input.sessionReports ? { sessionReports: input.sessionReports } : {}),
    instructions: input.instructions,
    peripherals: { ...input.compatibility.peripherals, mcp: input.mcp },
    modelProvider: input.modelProvider,
  });
  // The gateway is the runtime's private admission layer; only this projection reaches a client.
  return input.miniAppAgent
    ? {
        ...application,
        miniAppAgent: createProcessLocalMiniAppAgentApplication(input.miniAppAgent),
      }
    : application;
}
