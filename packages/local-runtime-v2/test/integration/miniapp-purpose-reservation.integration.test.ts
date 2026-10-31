/**
 * Mini App ownership is a server-side fact, not something a caller can declare.
 *
 * A Mini App session is identified by its `purpose` label, and that label is what routes permission
 * asks back to the plugin that owns them. The application session-creation request also accepts a
 * `purpose`, so without a guard any caller could mint a session that the runtime then treats as
 * plugin-owned — claiming another plugin's approval routing. Creating such a session must be refused;
 * the runtime's own session ports write the label through the internal path instead.
 *
 * Real host, real session lifecycle; only the model runner is unused because no turn runs here.
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

async function bootHost(): Promise<CreatedLocalRuntimeHost> {
  const dataDir = await mkdtemp(join(tmpdir(), 'miniapp-purpose-'));
  dataDirs.push(dataDir);
  await mkdir(join(dataDir, 'workspace'), { recursive: true });
  const config: LocalRuntimeConfig = { dataDir };
  const host = await createLocalRuntimeHostV2ForTest({
    dataDir,
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

describe('Mini App session purpose reservation', () => {
  it(
    'refuses a caller-declared Mini App ownership label',
    async () => {
      const host = await bootHost();
      const conversation = host.apiHost.runtimeConversation!;

      // Reserved for runtime-owned Sessions; a caller-supplied label would be an ownership claim.
      await expect(
        conversation.lifecycle.createSession({
          agentName: 'mavis',
          workspaceDir: join(host.dataDir, 'workspace'),
          sessionType: 'root',
          purpose: 'miniapp:spoofed.plugin',
        }),
      ).rejects.toMatchObject({
        reason: 'purpose-reserved',
        message: expect.stringMatching(/reserved for runtime-owned/i),
      });

      // A reserved label with surrounding whitespace is the same claim.
      await expect(
        conversation.lifecycle.createSession({
          agentName: 'mavis',
          workspaceDir: join(host.dataDir, 'workspace'),
          sessionType: 'root',
          purpose: '  miniapp:spoofed.plugin',
        }),
      ).rejects.toMatchObject({ reason: 'purpose-reserved' });
    },
    120_000,
  );

  it(
    'refuses the same label on the non-root path that reuses internal session creation',
    async () => {
      const host = await bootHost();
      const conversation = host.apiHost.runtimeConversation!;

      // This is the branch that used to hand a caller's `purpose` to `createInternalSession`.
      await expect(
        conversation.lifecycle.createSession({
          agentName: 'mavis',
          sessionType: 'branch',
          purpose: 'miniapp:spoofed.plugin',
        }),
      ).rejects.toMatchObject({
        reason: 'purpose-reserved',
        message: expect.stringMatching(/reserved for runtime-owned/i),
      });
    },
    120_000,
  );

  it(
    'still creates an ordinary session without a purpose',
    async () => {
      const host = await bootHost();
      const conversation = host.apiHost.runtimeConversation!;

      const plain = await conversation.lifecycle.createSession({
        agentName: 'mavis',
        workspaceDir: join(host.dataDir, 'workspace'),
        sessionType: 'root',
      });
      expect(plain.sessionId).toBeTruthy();
    },
    120_000,
  );
});
