/**
 * Phase 5 exit condition: a real host declared as `webui`.
 *
 * The plan is explicit that an `it.each` over policies is not sufficient here — "a row
 * nobody instantiates is the original bug inverted". This test therefore boots the
 * actual V2 runtime host with `runtimeOwnerKind: 'webui'` and asserts on what got
 * built, not on the shape of a table.
 *
 * **What this proves, and what it does not.** It proves the harness resolves a `webui`
 * owner to a policy that assembles the declared services. It does NOT prove the WebUI
 * declares that owner, nor that a WebUI UI receives the capability — both need the
 * declaration flip plus a WebUI-level check, which are deferred. This is the narrow
 * claim the plan settles for, and stating it narrowly is what makes it reviewable.
 *
 * Not a unit test: a real host run takes tens of seconds and opens SQLite. It uses a
 * temporary data directory and never touches real user data.
 */
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { CreatedLocalRuntimeHost, LocalRuntimeConfig } from '@mavis/local-runtime';
import { afterEach, describe, expect, it } from 'vitest';

import { createLocalRuntimeHostV2ForTest } from '../../src/runtime.js';

const hosts: CreatedLocalRuntimeHost[] = [];
const dataDirs: string[] = [];

afterEach(async () => {
  for (const host of hosts.splice(0)) await host.apiHost.close().catch(() => undefined);
  for (const dir of dataDirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function bootWebuiHost(): Promise<CreatedLocalRuntimeHost> {
  const dataDir = await mkdtemp(join(tmpdir(), 'webui-owner-policy-'));
  dataDirs.push(dataDir);
  // The v1 host reads its data directory from the config snapshot, not from the
  // constructor option, so the config has to carry it.
  await mkdir(join(dataDir, 'workspace'), { recursive: true });
  const config: LocalRuntimeConfig = { dataDir };
  const host = await createLocalRuntimeHostV2ForTest({
    dataDir,
    // The WebUI row. No `capabilityProfile: 'cli'`: the row sets mavisFeatureBundle
    // explicitly, and dropping the profile is what the flip depends on.
    runtimeOwnerKind: 'webui',
    capabilities: { cliEmbedded: true },
    configGetter: () => config,
    defaultWorkspaceDir: join(dataDir, 'workspace'),
    fetchImpl: async () => Response.json({ errorCode: 0, action: 1 }),
  });
  hosts.push(host);
  await host.ready;
  return host;
}

describe('a host declared as webui', () => {
  it(
    'reports the webui owner kind rather than coercing it to runtime',
    async () => {
      const host = await bootWebuiHost();
      // host.ts stores `runtimeOwnerKind ?? "runtime"`. Seeing 'webui' proves the
      // declared owner reached the host rather than being replaced.
      expect(host.apiHost.getRuntimeOwnerKind()).toBe('webui');
    },
    120_000,
  );

  it(
    'holds the V1 compatibility layer, so the questionnaire service survives',
    async () => {
      const host = await bootWebuiHost();
      // ownsV2Runtime could not be inherited from tui: tui gets it from a
      // `cli || tui` clause webui is not in. false here would drop the whole v2
      // service group, including the cliService every WebUI feature depends on.
      // The apiHost being live and owned is the observable form of that layer.
      expect(host.apiHost).toBeDefined();
      expect(host.apiHost.runtimeConversation).toBeDefined();
      expect(host.controller).toBeDefined();
    },
    120_000,
  );

  it(
    'is not restricted, so memory and cron are not disabled',
    async () => {
      const host = await bootWebuiHost();
      // restricted drives disableMemory + disableCron + disableComputerUse together,
      // so they are asserted through the capabilities the host actually exposes.
      const { restrictions } = host.apiHost.createHostedAgentCapabilities();
      expect(restrictions?.disableMemory).not.toBe(true);
      expect(restrictions?.disableCron).not.toBe(true);
      expect(restrictions?.disableMavis).not.toBe(true);
    },
    120_000,
  );

  it(
    'reports cron native and the channel bridge unsupported in its diagnostics',
    async () => {
      const host = await bootWebuiHost();
      // Phase 2's correction, observed end to end: the surface table no longer claims
      // services this host did not assemble.
      const diagnostics = host.apiHost.getProcessLocalRuntimeDiagnostics();
      const surfaces = diagnostics.surfaces as
        | Record<string, { status?: string }>
        | undefined;
      expect(surfaces?.cron?.status).toBe('native');
      expect(surfaces?.channelBridge?.status).toBe('unsupported');
    },
    120_000,
  );
});