import path from "node:path";
import { stripRuntimeBoundaryKeysFrom } from "@mavis/shared/runtime-boundary-env";

type ProcessEnvironment = Record<string, string | undefined>;

const HOST_KEYS = {
  runtimeExecutable: "__MAVIS_MCODE_TOOLS_RUNTIME_EXECUTABLE",
  brokerEndpoint: "__MAVIS_MCODE_TOOLS_BROKER_ENDPOINT",
  brokerCapabilityFile: "__MAVIS_MCODE_TOOLS_BROKER_CAPABILITY_FILE",
  configDir: "__MAVIS_MCODE_TOOLS_CONFIG_DIR",
  region: "__MAVIS_MCODE_TOOLS_REGION",
} as const;

export interface WebuiMcodeToolsEnvironmentActivation {
  ensureCommandPath(): void;
  restore(): void;
}

/** Projects the private host variables into the child tool's public contract. */
export function configureWebuiMcodeToolsChildEnvironment(
  environment: ProcessEnvironment = process.env,
): boolean {
  const runtimeExecutable = environment[HOST_KEYS.runtimeExecutable]?.trim();
  const brokerEndpoint = environment[HOST_KEYS.brokerEndpoint]?.trim();
  const brokerCapabilityFile = environment[HOST_KEYS.brokerCapabilityFile]?.trim();
  const configDir = environment[HOST_KEYS.configDir]?.trim();
  const region = environment[HOST_KEYS.region]?.trim();
  const values = [runtimeExecutable, brokerEndpoint, brokerCapabilityFile, configDir, region];
  if (values.every((value) => !value)) return false;
  if (values.some((value) => !value) || (region !== "cn" && region !== "en"))
    throw new Error("The WebUI mcode-tools host environment is incomplete.");
  stripRuntimeBoundaryKeysFrom(environment, "agent-runtime");
  for (const key of Object.values(HOST_KEYS)) delete environment[key];
  environment.ELECTRON_RUN_AS_NODE = "1";
  environment.MCODE_REGION = region;
  environment.MCODE_CONFIG_DIR = configDir;
  environment.MCODE_AUTH_PROVIDER = "shared-broker";
  environment.MCODE_AUTH_BROKER_ENDPOINT = brokerEndpoint;
  environment.MCODE_AUTH_BROKER_CAPABILITY_FILE = brokerCapabilityFile;
  return true;
}

/**
 * Installs the host-only environment consumed by the embedded mcode-tools
 * command. The child launcher removes these keys before it starts the tool,
 * so the OAuth broker capability never becomes part of the child tool's
 * ordinary environment.
 */
export function activateWebuiMcodeToolsEnvironment(
  environment: ProcessEnvironment,
  options: {
    readonly runtimeExecutable: string;
    readonly brokerEndpoint: string;
    readonly brokerCapabilityFile: string;
    readonly configDir: string;
    readonly region: "cn" | "en";
    readonly commandBinDir: string;
  },
): WebuiMcodeToolsEnvironmentActivation {
  if (!path.isAbsolute(options.runtimeExecutable))
    throw new Error("The WebUI mcode-tools runtime executable must be absolute.");
  const assigned: ProcessEnvironment = {
    [HOST_KEYS.runtimeExecutable]: options.runtimeExecutable,
    [HOST_KEYS.brokerEndpoint]: options.brokerEndpoint,
    [HOST_KEYS.brokerCapabilityFile]: options.brokerCapabilityFile,
    [HOST_KEYS.configDir]: options.configDir,
    [HOST_KEYS.region]: options.region,
  };
  const previous = Object.fromEntries(
    Object.keys(assigned).map((key) => [key, environment[key]]),
  ) as ProcessEnvironment;
  for (const [key, value] of Object.entries(assigned)) {
    if (value === undefined) delete environment[key];
    else environment[key] = value;
  }

  const pathKey =
    Object.keys(environment).find((key) => key.toLowerCase() === "path") ??
    "PATH";
  const commandBinDir = path.normalize(options.commandBinDir);
  const wasPresent = splitPath(environment[pathKey]).includes(commandBinDir);
  const ensureCommandPath = (): void => {
    const entries = splitPath(environment[pathKey]).filter(
      (entry) => entry !== commandBinDir,
    );
    environment[pathKey] = [commandBinDir, ...entries].join(path.delimiter);
  };
  ensureCommandPath();

  let restored = false;
  return {
    ensureCommandPath,
    restore(): void {
      if (restored) return;
      restored = true;
      for (const [key, value] of Object.entries(previous)) {
        if (environment[key] === assigned[key]) {
          if (value === undefined) delete environment[key];
          else environment[key] = value;
        }
      }
      if (!wasPresent) {
        environment[pathKey] = splitPath(environment[pathKey])
          .filter((entry) => entry !== commandBinDir)
          .join(path.delimiter);
      }
    },
  };
}

function splitPath(value: string | undefined): string[] {
  return (value ?? "")
    .split(path.delimiter)
    .filter(Boolean)
    .map(path.normalize);
}
