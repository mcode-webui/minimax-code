/**
 * The skill hub catalogue gate.
 *
 * The browser client reads the remote catalogue the way the Desktop does. The gate
 * used to answer for the owner kind inline (`runtimeOwnerKind === 'electron'`), so
 * every browser client fell back to the local install ledger and the market view
 * showed no catalogue — the user could not browse skills at all.
 *
 * The decision is the owner row's `wiring.remoteSkillHub` cell now. This gate pins
 * that the cell reaches the catalogue, while a command-line client still needs a
 * managed runtime to read it.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import { shouldUseRemoteSkillHub } from '../../src/runtime/host-factory.js';
import type { CreateLocalRuntimeHostOptions } from '../../src/runtime/host-factory-types.js';

function hostOptions(
  overrides: Partial<CreateLocalRuntimeHostOptions>,
): CreateLocalRuntimeHostOptions {
  return overrides as CreateLocalRuntimeHostOptions;
}

describe('the skill hub catalogue gate', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('lets the browser client read the catalogue the way the desktop client does', () => {
    // A dev build of an unmanaged client: the runtime posture that used to close
    // the catalogue for every browser client.
    vi.stubEnv('MAVIS_BUILD_ENV', 'dev');
    vi.stubEnv('__MAVIS_RUNTIME_MANAGED', undefined);

    expect(shouldUseRemoteSkillHub(hostOptions({ runtimeOwnerKind: 'webui' }))).toBe(true);
    expect(shouldUseRemoteSkillHub(hostOptions({ runtimeOwnerKind: 'electron' }))).toBe(true);
  });

  it('keeps the catalogue closed for a command-line client that is not managed', () => {
    vi.stubEnv('MAVIS_BUILD_ENV', 'dev');
    vi.stubEnv('__MAVIS_RUNTIME_MANAGED', undefined);

    expect(shouldUseRemoteSkillHub(hostOptions({ runtimeOwnerKind: 'tui' }))).toBe(false);
    expect(shouldUseRemoteSkillHub(hostOptions({ runtimeOwnerKind: 'cli' }))).toBe(false);
  });

  it('lets a managed runtime open the catalogue for any owner', () => {
    vi.stubEnv('MAVIS_BUILD_ENV', 'prod');
    vi.stubEnv('__MAVIS_RUNTIME_MANAGED', undefined);

    expect(shouldUseRemoteSkillHub(hostOptions({ runtimeOwnerKind: 'tui' }))).toBe(true);
  });

  it('honours the explicit skill hub switch', () => {
    vi.stubEnv('MAVIS_BUILD_ENV', 'dev');
    vi.stubEnv('__MAVIS_RUNTIME_MANAGED', undefined);
    const configGetter = (() => ({ skillHub: { enabled: false } })) as unknown as
      CreateLocalRuntimeHostOptions['configGetter'];

    expect(
      shouldUseRemoteSkillHub(hostOptions({ runtimeOwnerKind: 'webui', configGetter })),
    ).toBe(false);
  });
});
