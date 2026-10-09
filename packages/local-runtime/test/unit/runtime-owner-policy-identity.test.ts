/**
 * Byte-identity proof for the phase 3 rewiring.
 *
 * Phase 3 of docs/webui/webui-client-identity-plan.md replaced ~20 owner-derived string
 * comparisons with reads of a resolved policy cell. The guarantee is that, for every
 * owner declaration in use today, the observable result is unchanged.
 *
 * This file is what makes that claim checkable rather than aspirational: every cell is
 * asserted against the ORIGINAL expression, transcribed verbatim from the call site it
 * replaced, evaluated over the same input space. If a cell is transposed onto the wrong
 * predicate, this fails.
 *
 * The guard values ('test', unknown owners) are deliberately NOT asserted here — they
 * change, and phase 3 says so. runtime-owner-policy.test.ts covers those.
 */

import { describe, expect, it } from 'vitest';

import { resolveRuntimeOwnerPolicy } from '../../src/runtime/runtime-owner-policy.js';

/** Every owner value a client can declare, plus absence and the test-only value. */
const KINDS = [
  undefined,
  'electron',
  'cli',
  'tui',
  'runtime',
  'test',
  'webui',
] as const;

/** Every host-configuration combination the factory can be called with. */
const HOST = [
  { cliEmbedded: true, electronHost: true, capabilityProfile: undefined },
  { cliEmbedded: true, electronHost: true, capabilityProfile: 'cli' },
  { cliEmbedded: true, electronHost: false, capabilityProfile: undefined },
  { cliEmbedded: true, electronHost: false, capabilityProfile: 'cli' },
  { cliEmbedded: false, electronHost: true, capabilityProfile: undefined },
  { cliEmbedded: false, electronHost: false, capabilityProfile: 'cli' },
] as const;

const INPUT_SPACE = KINDS.flatMap((kind) =>
  HOST.map((host) => ({ kind, ...host })),
);

/**
 * The declarations in use today, for which the guarantee holds. `'test'` and any
 * unrecognised value resolve through the guard and genuinely change; asserting them
 * here would assert the behaviour change as if it were a guarantee.
 */
const DECLARED_IN_USE = [undefined, 'electron', 'cli', 'tui', 'runtime'] as const;

function cells(kind: (typeof KINDS)[number], host: (typeof HOST)[number]) {
  return resolveRuntimeOwnerPolicy({ kind, ...host });
}

/* -------------------------------------------------------------------------- */
/* Original expressions, transcribed from the sites they replaced             */
/* -------------------------------------------------------------------------- */

/** runtime.ts:535-543, pre-rewiring. */
const originalOwnsV2Runtime = (
  kind: string | undefined,
  electronHost: boolean,
  cliEmbedded: boolean,
): boolean =>
  (kind === 'electron' && electronHost === true) ||
  ((kind === 'cli' || kind === 'tui') && cliEmbedded === true);

/** runtime.ts:843, pre-rewiring. */
const originalSchedulerHost = (kind: string | undefined): boolean => kind === 'electron';

/** runtime-browser-use-composition.ts:40, pre-rewiring. */
const originalOwnsElectronCapabilities = (kind: string | undefined): boolean =>
  kind === undefined || kind === 'electron';

/** profile-source.ts:104 and task-agent-binding-capture.ts:738, pre-rewiring. */
const originalCommandLineOwner = (kind: string | undefined): boolean =>
  kind === 'cli' || kind === 'tui';

/** hosted-agent-capability-factory.ts:18, pre-rewiring. */
const originalRestricted = (kind: string | undefined, cliEmbedded: boolean): boolean =>
  originalCommandLineOwner(kind) && cliEmbedded === true;

/** host.ts:1396, pre-rewiring (on the RAW option). */
const originalMemoryFeature = (kind: string | undefined): boolean => kind !== 'tui';

/** session-title-policy.ts:31-34, pre-rewiring. */
const originalTitleBypass = (kind: string | undefined): boolean =>
  kind === 'tui' || kind === 'cli';

/** agent-prompt-surface.ts:31, pre-rewiring. */
const originalPromptSurface = (kind: string | undefined): 'interactive' | 'cli' =>
  originalCommandLineOwner(kind) ? 'cli' : 'interactive';

/** host.ts:455 and host-channel-composition.ts:314-316, pre-rewiring. */
const originalChannelCapability = (capabilityProfile: 'cli' | undefined): boolean =>
  capabilityProfile !== 'cli';

/** services.ts:1001-1008, pre-rewiring. */
const originalCliProductPolicy = (kind: string | undefined): boolean =>
  originalCommandLineOwner(kind);

/** services.ts:1004, pre-rewiring. */
const originalTuiProductPolicy = (kind: string | undefined): boolean => kind === 'tui';

/** profile-source.ts:49 and task-agent-binding-capture.ts:355, pre-rewiring. */
const originalPromptProfile = (kind: string | undefined): 'desktop' | 'tui' =>
  kind === 'tui' ? 'tui' : 'desktop';

/** executor.ts:141-143, pre-rewiring. */
const originalTerminalControl = (kind: string | undefined): boolean => kind === 'tui';

/* -------------------------------------------------------------------------- */

describe('phase 3 byte-identity', () => {
  const identityInputSpace = INPUT_SPACE.filter((input) =>
    (DECLARED_IN_USE as readonly (string | undefined)[]).includes(input.kind),
  );

  it('covers every declared owner against every host configuration', () => {
    expect(identityInputSpace.length).toBe(DECLARED_IN_USE.length * HOST.length);
  });

  it.each(identityInputSpace.map((i) => [String(i.kind), i] as const))(
    'wiring cells match the original expressions for owner %s',
    (_label, input) => {
      const { wiring } = cells(input.kind, input);
      expect(wiring.ownsV2Runtime).toBe(
        originalOwnsV2Runtime(input.kind, input.electronHost, input.cliEmbedded),
      );
      expect(wiring.schedulerHost).toBe(originalSchedulerHost(input.kind));
      expect(wiring.cronService).toBe(originalOwnsElectronCapabilities(input.kind));
      // Channels keep BOTH switches: the original code read capabilityProfile at one
      // site and the owner kind at another. See the dedicated test below — the two
      // disagree for one row, and that convergence is deliberate.
      expect(wiring.channelService).toBe(
        originalChannelCapability(input.capabilityProfile) &&
          originalOwnsElectronCapabilities(input.kind),
      );
      expect(wiring.browserActivation).toBe(
        originalOwnsElectronCapabilities(input.kind) ? 'desktop-plugin' : 'explicit-config',
      );
    },
  );

  it.each(identityInputSpace.map((i) => [String(i.kind), i] as const))(
    'execution cells match the original expressions for owner %s',
    (_label, input) => {
      const { execution } = cells(input.kind, input);
      expect(execution.restricted).toBe(
        originalRestricted(input.kind, input.cliEmbedded),
      );
      expect(execution.memoryFeature).toBe(originalMemoryFeature(input.kind));
      expect(execution.mavisFeatureBundle).toBe(
        input.capabilityProfile !== 'cli',
      );
      expect(execution.titleSafetyBypass).toBe(originalTitleBypass(input.kind));
      expect(execution.promptSurfaceDefault).toBe(originalPromptSurface(input.kind));
      expect(execution.promptProfile).toBe(originalPromptProfile(input.kind));
      expect(execution.executesTerminalControl).toBe(originalTerminalControl(input.kind));
    },
  );

  it.each(identityInputSpace.map((i) => [String(i.kind), i] as const))(
    'reviewPolicy reproduces both product-policy flags for owner %s',
    (_label, input) => {
      const { execution } = cells(input.kind, input);
      // The tui branch returns first, so a tui owner that is also a command-line owner
      // resolves to 'tui'. This is the merge of two booleans that hung off the same
      // kind in services.ts.
      expect(execution.reviewPolicy === 'cli').toBe(
        originalCliProductPolicy(input.kind) && !originalTuiProductPolicy(input.kind),
      );
      expect(execution.reviewPolicy === 'tui').toBe(originalTuiProductPolicy(input.kind));
      expect(execution.reviewPolicy === 'neither').toBe(
        !originalCliProductPolicy(input.kind) && !originalTuiProductPolicy(input.kind),
      );
    },
  );

  it('keeps the absent owner distinct from runtime on every cell', () => {
    const absent = cells(undefined, HOST[0]);
    const runtime = cells('runtime', HOST[0]);
    // Both report kind "runtime" for diagnostics, so only the cells can tell them
    // apart. If these ever converge, a coercion somewhere has been removed.
    expect(absent.kind).toBe(runtime.kind);
    expect(absent.wiring.cronService).toBe(true);
    expect(runtime.wiring.cronService).toBe(false);
    expect(absent.wiring.channelService).toBe(true);
    expect(runtime.wiring.channelService).toBe(false);
    expect(absent.wiring.browserActivation).toBe('desktop-plugin');
    expect(runtime.wiring.browserActivation).toBe('explicit-config');
  });

  it('does not change answers for the test-only owner beyond the declared guard', () => {
    // 'test' is the one value whose answers genuinely change, and phase 3 says so.
    // This pins the size of that change rather than pretending it does not exist.
    const policy = cells('test', HOST[1]);
    expect(policy.wiring.ownsV2Runtime).toBe(true);
    expect(policy.execution.restricted).toBe(true);
    expect(policy.execution.memoryFeature).toBe(false);
  });

  it('converges the two channel switches, which disagreed on SEVEN combinations', () => {
    // "Byte-identical" is not literally true for one cell, and the scope is wider than
    // a single case. Merging two switches into one cell — which the plan requires, so
    // that dropping capabilityProfile cannot silently re-enable channels — cannot
    // reproduce both original answers where they disagreed.
    //
    // `host.ts` asked only `capabilityProfile !== 'cli'`; `services.ts` asked only the
    // owner kind. One cell cannot be both. This enumerates every disagreeing input so
    // the divergence is measured rather than asserted about.
    const diverging: string[] = [];
    for (const kind of [undefined, 'electron', 'cli', 'tui', 'runtime', 'test', 'webui'] as const) {
      for (const capabilityProfile of [undefined, 'cli'] as const) {
        const hostOld = originalChannelCapability(capabilityProfile);
        const servicesOld = originalOwnsElectronCapabilities(kind);
        const cell = cells(kind, {
          cliEmbedded: false,
          electronHost: false,
          capabilityProfile,
        }).wiring.channelService;
        if (hostOld !== servicesOld) {
          expect(cell, `${String(kind)}/${String(capabilityProfile)}`).toBe(
            // The stricter, kind-based answer.
            hostOld && servicesOld,
          );
          diverging.push(`${String(kind)}/${String(capabilityProfile)}`);
        } else {
          // Where the two old gates agreed, the cell must reproduce that answer.
          expect(cell, `${String(kind)}/${String(capabilityProfile)}`).toBe(hostOld);
        }
      }
    }
    // Pinned so adding or removing a case is a visible change, not a silent one.
    expect(diverging.sort()).toEqual([
      'cli/undefined',
      'electron/cli',
      'runtime/undefined',
      'test/undefined',
      'tui/undefined',
      'undefined/cli',
      'webui/undefined',
    ]);

    // The one in-tree path that reaches this coercion is unaffected: 'runtime' is the
    // string host.ts substitutes for an ABSENT owner, and that arrives as 'absent'.
    expect(cells(undefined, {
      cliEmbedded: false,
      electronHost: false,
      capabilityProfile: undefined,
    }).wiring.channelService).toBe(true);
  });
});