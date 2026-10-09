import { chmod, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  startMcodeToolsAuthLeaseBroker,
  validateMcodeToolsResource,
  type McodeToolsAuthLeaseBroker,
  type McodeToolsHostAuthSession,
  type McodeToolsHostLogger,
} from "@mavis/mcode-tools-host";
import {
  activateWebuiMcodeToolsEnvironment,
  type WebuiMcodeToolsEnvironmentActivation,
} from "./mcode-tools-environment.js";

export interface WebuiMcodeToolsReadiness {
  readonly requested: boolean;
  readonly ready: boolean;
  readonly category:
    | "disabled"
    | "ready"
    | "resource_unavailable"
    | "broker_unavailable"
    | "host_unavailable";
  ensureCommandPath(): void;
  dispose(): Promise<void>;
}

export interface WebuiMcodeToolsIntegrationOptions {
  readonly requested: boolean;
  readonly dataDir: string;
  readonly buildEnv: "dev" | "test" | "staging" | "prod";
  readonly region: "cn" | "en";
  readonly session: McodeToolsHostAuthSession;
  readonly entryUrl: string;
  readonly environment?: Record<string, string | undefined>;
  readonly logger?: McodeToolsHostLogger;
}

export interface WebuiMcodeToolsIntegrationDependencies {
  readonly validateResource?: typeof validateMcodeToolsResource;
  readonly startBroker?: typeof startMcodeToolsAuthLeaseBroker;
  readonly createRuntimeDir?: () => Promise<string>;
  readonly removeRuntimeDir?: (directory: string) => Promise<void>;
  readonly activateEnvironment?: typeof activateWebuiMcodeToolsEnvironment;
}

const NOOP_DISPOSE = async (): Promise<void> => undefined;
const NOOP = (): void => undefined;

export async function prepareWebuiMcodeToolsIntegration(
  options: WebuiMcodeToolsIntegrationOptions,
  dependencies: WebuiMcodeToolsIntegrationDependencies = {},
): Promise<WebuiMcodeToolsReadiness> {
  const buildEnv = normalizeBuildEnv(options.buildEnv);
  if (!options.requested)
    return inactiveReadiness(false, "disabled");
  const logger = options.logger ?? { info: NOOP, warn: NOOP };
  const environment = options.environment ?? process.env;
  const removeRuntimeDir =
    dependencies.removeRuntimeDir ?? removeWebuiMcodeToolsRuntimeDir;
  let runtimeDir: string | undefined;
  let broker: McodeToolsAuthLeaseBroker | undefined;
  let activation: WebuiMcodeToolsEnvironmentActivation | undefined;
  try {
    const resource = (dependencies.validateResource ?? validateMcodeToolsResource)({
      resourceDir: resolveBundledResourceDir(options.entryUrl),
      expectedBuildEnv: buildEnv,
    });
    runtimeDir = await (
      dependencies.createRuntimeDir ?? createWebuiMcodeToolsRuntimeDir
    )();
    broker = await (dependencies.startBroker ?? startMcodeToolsAuthLeaseBroker)({
      dataDir: runtimeDir,
      session: options.session,
      logger,
    });
    const configDir = path.join(
      options.dataDir,
      "integrations",
      "mcode-tools",
      options.region,
    );
    await mkdir(configDir, { recursive: true, mode: 0o700 });
    if (process.platform !== "win32") await chmod(configDir, 0o700);
    activation = (
      dependencies.activateEnvironment ?? activateWebuiMcodeToolsEnvironment
    )(environment, {
      runtimeExecutable: process.execPath,
      brokerEndpoint: broker.endpoint,
      brokerCapabilityFile: broker.capabilityFile,
      configDir,
      region: options.region,
      commandBinDir: resolveCommandBinDir(options.entryUrl),
    });
    return {
      requested: true,
      ready: true,
      category: "ready",
      ensureCommandPath: activation.ensureCommandPath,
      async dispose(): Promise<void> {
        activation?.restore();
        await broker?.dispose();
        if (runtimeDir) await removeRuntimeDir(runtimeDir);
      },
    };
  } catch (error) {
    activation?.restore();
    await broker?.dispose().catch(() => undefined);
    if (runtimeDir) await removeRuntimeDir(runtimeDir).catch(() => undefined);
    logger.warn(`mcode-tools readiness unavailable: ${errorMessage(error)}`);
    return inactiveReadiness(true, classifyFailure(error));
  }
}

export function createWebuiAuthLeaseSession(
  getAuthContext: () => { readonly accessToken?: string } | undefined,
  invalidate: (accessToken?: string) => void,
): McodeToolsHostAuthSession {
  let generation = 0;
  let lastToken: string | undefined;
  const read = () => getAuthContext()?.accessToken?.trim() || undefined;
  const currentGeneration = (token: string | undefined): number => {
    if (token !== lastToken) {
      lastToken = token;
      generation += 1;
    }
    return Math.max(1, generation);
  };
  return {
    async getStatus() {
      const token = read();
      return {
        status: token ? "authenticated" : "anonymous",
        generation: currentGeneration(token),
      };
    },
    async getAccessToken(minValidityMs: number) {
      const token = read();
      if (!token) throw new Error("WebUI managed credentials are unavailable");
      return {
        accessToken: token,
        expiresAtMs: Date.now() + Math.max(minValidityMs, 60_000),
        generation: currentGeneration(token),
        scopes: ["agent.default"],
        audience: "agent-backend",
      };
    },
    async handleUnauthorized(requestGeneration: number) {
      const token = read();
      if (requestGeneration === currentGeneration(token)) invalidate(token);
      return "logout";
    },
    watch() {
      return () => undefined;
    },
  };
}

function resolveBundledResourceDir(entryUrl: string): string {
  return path.join(path.dirname(fileURLToPath(entryUrl)), "embedded", "mcode-tools");
}

function resolveCommandBinDir(entryUrl: string): string {
  return path.join(path.dirname(fileURLToPath(entryUrl)), "internal-bin");
}

function normalizeBuildEnv(
  buildEnv: WebuiMcodeToolsIntegrationOptions["buildEnv"],
): "test" | "staging" | "prod" {
  return buildEnv === "dev" ? "test" : buildEnv;
}

async function createWebuiMcodeToolsRuntimeDir(): Promise<string> {
  const parent = process.platform === "win32" ? tmpdir() : "/tmp";
  const directory = await mkdtemp(path.join(parent, `mcode-tools-webui-${process.pid}-`));
  if (process.platform !== "win32") await chmod(directory, 0o700);
  return directory;
}

async function removeWebuiMcodeToolsRuntimeDir(directory: string): Promise<void> {
  await rm(directory, { recursive: true, force: true });
}

function inactiveReadiness(
  requested: boolean,
  category: Exclude<WebuiMcodeToolsReadiness["category"], "ready">,
): WebuiMcodeToolsReadiness {
  return { requested, ready: false, category, ensureCommandPath: NOOP, dispose: NOOP_DISPOSE };
}

function classifyFailure(error: unknown): Exclude<WebuiMcodeToolsReadiness["category"], "disabled" | "ready"> {
  const message = errorMessage(error).toLowerCase();
  if (message.includes("manifest") || message.includes("resource") || message.includes("sha256"))
    return "resource_unavailable";
  if (message.includes("broker") || message.includes("socket") || message.includes("address"))
    return "broker_unavailable";
  return "host_unavailable";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
