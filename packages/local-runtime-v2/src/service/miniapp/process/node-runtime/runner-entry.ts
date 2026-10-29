import { existsSync } from 'node:fs';
import path from 'node:path';

import { MiniAppNodeRuntimeError } from './node-runtime-startup-error.js';

/** The argument vector that starts the runner child, after the Node executable. */
export interface MiniAppRunnerLaunch {
  readonly args: readonly string[];
}

export interface MiniAppRunnerLaunchOptions {
  /** The directory this module was loaded from; the runner entry sits beside it. */
  readonly moduleDir: string;
  /** An explicit runner entry overrides the resolved one. */
  readonly runnerPath?: string;
  /** Existence probe, injectable so the resolution can be exercised without a filesystem. */
  readonly fileExists?: (target: string) => boolean;
}

interface DevelopmentToolchain {
  /** The TypeScript loader that starts the runner entry. */
  readonly loader: string;
  /** The path map the loader resolves the runner's workspace imports against. */
  readonly tsconfig: string;
}

const RUNNER_ENTRY_BASENAME = 'host-runner';
const DEVELOPMENT_TSCONFIG_BASENAME = 'tsconfig.standalone.json';
const DEVELOPMENT_LOADER_SEGMENTS = ['node_modules', 'tsx', 'dist', 'cli.mjs'] as const;

/**
 * Resolves how the runner child process is started.
 *
 * A built Host carries `host-runner.js` beside this module and starts it with plain Node. A
 * source checkout carries only `host-runner.ts`, whose relative imports name the compiled
 * extensions and whose workspace imports need the repository's path map, so the child needs the
 * repository's TypeScript loader as well. The answer is therefore an argument vector, not a
 * single path: the two shapes cannot both be expressed as one file path.
 */
export function resolveMiniAppRunnerLaunch(
  options: MiniAppRunnerLaunchOptions,
): MiniAppRunnerLaunch {
  const fileExists = options.fileExists ?? existsSync;
  if (options.runnerPath !== undefined) return { args: [options.runnerPath] };
  const built = path.join(options.moduleDir, `${RUNNER_ENTRY_BASENAME}.js`);
  if (fileExists(built)) return { args: [built] };
  const source = path.join(options.moduleDir, `${RUNNER_ENTRY_BASENAME}.ts`);
  if (!fileExists(source)) {
    throw new MiniAppNodeRuntimeError(
      'RUNNER_START_FAILED',
      `Mini App runner entry was not found beside the runtime module (${options.moduleDir})`,
    );
  }
  const toolchain = findDevelopmentToolchain(options.moduleDir, fileExists);
  if (!toolchain) {
    throw new MiniAppNodeRuntimeError(
      'RUNNER_START_FAILED',
      'Mini App runner entry is TypeScript and no development toolchain was found for it',
    );
  }
  return { args: [toolchain.loader, '--tsconfig', toolchain.tsconfig, source] };
}

/**
 * The repository root is the only directory that holds both the path map and the loader, so the
 * search walks up from the runtime module until it finds the pair.
 */
function findDevelopmentToolchain(
  moduleDir: string,
  fileExists: (target: string) => boolean,
): DevelopmentToolchain | undefined {
  let current = path.resolve(moduleDir);
  for (;;) {
    const tsconfig = path.join(current, DEVELOPMENT_TSCONFIG_BASENAME);
    const loader = path.join(current, ...DEVELOPMENT_LOADER_SEGMENTS);
    if (fileExists(tsconfig) && fileExists(loader)) return { loader, tsconfig };
    const parent = path.dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}
