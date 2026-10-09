/**
 * Phase 2: the surface table reports what the host actually assembles.
 *
 * `buildLocalRuntimeSurfaceCapabilities` used to begin with `void mode;` and return a
 * constant 42-key table. Two rows contradicted their own gating: `cron` reported
 * `native` on a host where `enableCron` was false, and `channelBridge` reported
 * `native` where `capabilityProfile: 'cli'` disabled channels.
 *
 * These assertions are on the returned document, because that is the whole blast
 * radius: the only readers of `surfaces` feed `buildRuntimeDoctorSnapshot` and the
 * status-document builders. Correcting it changes a diagnostics document and nothing
 * else — which is also why this phase must not carry its own justification.
 *
 * The table is a *reporting* vocabulary. It never becomes an authority for wiring.
 */

import { describe, expect, it } from 'vitest';

import { buildLocalRuntimeSurfaceCapabilities } from '../../src/runtime/mode.js';
import { resolveRuntimeOwnerPolicy } from '../../src/runtime/runtime-owner-policy.js';

const MODE = 'clean' as const;

function surfacesFor(kind: string | undefined, capabilityProfile?: 'cli') {
  const policy = resolveRuntimeOwnerPolicy({
    kind,
    cliEmbedded: true,
    electronHost: true,
    capabilityProfile,
  });
  return buildLocalRuntimeSurfaceCapabilities(MODE, policy);
}

describe('surface capabilities reflect the owner policy', () => {
  it('reports cron native on an electron owner, which assembles it', () => {
    const surfaces = surfacesFor('electron');
    expect(surfaces.cron.status).toBe('native');
    expect(surfaces.channelBridge.status).toBe('native');
  });

  it('reports cron unsupported on a tui owner, which does not assemble it', () => {
    const surfaces = surfacesFor('tui', 'cli');
    expect(surfaces.cron.status).toBe('unsupported');
    expect(surfaces.channelBridge.status).toBe('unsupported');
    // The reason must say why, not just that it is off.
    expect(surfaces.cron.reason).toContain('does not assemble a Cron service');
  });

  it('reports channelBridge unsupported when capabilityProfile disables channels', () => {
    // The other half of the double gate: an electron owner still loses channels here.
    const surfaces = surfacesFor('electron', 'cli');
    expect(surfaces.cron.status).toBe('native');
    expect(surfaces.channelBridge.status).toBe('unsupported');
  });

  it('reports cron native for an absent owner, faithfully recording the incoherence', () => {
    // services.ts reads the raw undefined and builds cron. The table follows the
    // behaviour rather than the intent — see the `'absent'` row.
    const surfaces = surfacesFor(undefined);
    expect(surfaces.cron.status).toBe('native');
    expect(surfaces.channelBridge.status).toBe('native');
  });

  it('reports cron and channels unsupported for an unrecognised owner', () => {
    const surfaces = surfacesFor('some-future-client');
    expect(surfaces.cron.status).toBe('unsupported');
    expect(surfaces.channelBridge.status).toBe('unsupported');
  });

  it('keeps the table shape stable whether or not a policy is supplied', () => {
    const withPolicy = buildLocalRuntimeSurfaceCapabilities(MODE, resolveRuntimeOwnerPolicy({
      kind: 'electron',
      cliEmbedded: true,
      electronHost: true,
      capabilityProfile: undefined,
    }));
    const withoutPolicy = buildLocalRuntimeSurfaceCapabilities(MODE);
    // Phase 2 is diagnostics-only, so a caller that supplies no policy still gets the
    // historical constant table rather than an error.
    expect(Object.keys(withPolicy).sort()).toEqual(Object.keys(withoutPolicy).sort());
    expect(withoutPolicy.cron.status).toBe('native');
    expect(withoutPolicy.channelBridge.status).toBe('native');
  });

  it('leaves every other row untouched', () => {
    const surfaces = surfacesFor('tui', 'cli');
    // Only the two rows the plan names may change. If a third one moves, this is no
    // longer a diagnostics-only change.
    expect(surfaces['agent.core'].status).toBe('native');
    expect(surfaces['agent.identity'].status).toBe('native');
    expect(surfaces.diagnostics.status).toBe('native');
    expect(surfaces['eventBus'].status).toBe('native');
  });
});