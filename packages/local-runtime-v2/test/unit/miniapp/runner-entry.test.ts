import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { resolveMiniAppRunnerLaunch } from '../../../src/service/miniapp/process/node-runtime/runner-entry.js';

const MODULE_DIR = path.join(
  '/repo',
  'packages',
  'local-runtime-v2',
  'src',
  'service',
  'miniapp',
  'process',
  'node-runtime',
);
const TOOLCHAIN_ROOT = '/repo';
const TSCONFIG = path.join(TOOLCHAIN_ROOT, 'tsconfig.standalone.json');
const LOADER = path.join(TOOLCHAIN_ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');

function fileExistsIn(files: readonly string[]): (target: string) => boolean {
  const known = new Set(files);
  return (target: string) => known.has(target);
}

describe('Mini App runner entry resolution', () => {
  it('starts the built entry beside the runtime module with plain Node', () => {
    const built = path.join(MODULE_DIR, 'host-runner.js');
    const launch = resolveMiniAppRunnerLaunch({
      moduleDir: MODULE_DIR,
      fileExists: fileExistsIn([built]),
    });
    expect(launch.args).toEqual([built]);
  });

  it('starts a TypeScript entry through the repository loader and path map', () => {
    const source = path.join(MODULE_DIR, 'host-runner.ts');
    const launch = resolveMiniAppRunnerLaunch({
      moduleDir: MODULE_DIR,
      fileExists: fileExistsIn([source, TSCONFIG, LOADER]),
    });
    expect(launch.args).toEqual([LOADER, '--tsconfig', TSCONFIG, source]);
  });

  it('prefers the built entry when both shapes are present', () => {
    const built = path.join(MODULE_DIR, 'host-runner.js');
    const launch = resolveMiniAppRunnerLaunch({
      moduleDir: MODULE_DIR,
      fileExists: fileExistsIn([
        built,
        path.join(MODULE_DIR, 'host-runner.ts'),
        TSCONFIG,
        LOADER,
      ]),
    });
    expect(launch.args).toEqual([built]);
  });

  it('honours an explicit runner entry', () => {
    const launch = resolveMiniAppRunnerLaunch({
      moduleDir: MODULE_DIR,
      runnerPath: '/custom/runner.js',
      fileExists: fileExistsIn([path.join(MODULE_DIR, 'host-runner.js')]),
    });
    expect(launch.args).toEqual(['/custom/runner.js']);
  });

  it('fails when no runner entry sits beside the runtime module', () => {
    expect(() =>
      resolveMiniAppRunnerLaunch({
        moduleDir: MODULE_DIR,
        fileExists: fileExistsIn([TSCONFIG, LOADER]),
      }),
    ).toThrowError(expect.objectContaining({ code: 'RUNNER_START_FAILED' }));
  });

  it('fails when the entry is TypeScript and no toolchain can start it', () => {
    expect(() =>
      resolveMiniAppRunnerLaunch({
        moduleDir: MODULE_DIR,
        fileExists: fileExistsIn([path.join(MODULE_DIR, 'host-runner.ts')]),
      }),
    ).toThrowError(expect.objectContaining({ code: 'RUNNER_START_FAILED' }));
  });
});
