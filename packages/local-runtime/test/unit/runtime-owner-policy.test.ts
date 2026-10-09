/**
 * Characterisation tests for the runtime owner policy.
 *
 * Phase 1 of docs/webui/webui-client-identity-plan.md extracts six predicates into
 * one module and adds `resolveRuntimeOwnerPolicy`. This file has two jobs, and the
 * split matters:
 *
 *   - `describe('today's predicates')` pins the CURRENT behaviour of every predicate
 *     the extraction moves, read from their existing homes. It is written first and
 *     is the safety argument for the extraction: if a cell's value changes anywhere
 *     below, phase 1's behaviour-identical claim is falsified here rather than in
 *     production.
 *   - `describe('resolveRuntimeOwnerPolicy')` pins the new resolver's rows,
 *     including `'absent'` and the unknown-owner guard.
 *
 * Phase 1 changes no call site. These tests are therefore expected to stay green
 * through phase 1 and to be joined by a byte-identical comparison in phase 3, when
 * call sites actually start reading cells.
 */

import { describe, expect, it } from 'vitest';

import {
  assertNeverRuntimeOwnerRow,
  isCliRestrictedRuntime,
  isDeclaredRuntimeOwnerKind,
  RUNTIME_OWNER_KINDS,
  type RuntimeOwnerKind,
  resolveRuntimeOwnerPolicy,
  type RuntimeOwnerPolicy,
  type RuntimeOwnerRow,
} from '../../src/runtime/runtime-owner-policy.js';

// The three existing predicates that are exported from their current homes. Reading
// them here is what turns "the extraction is mechanical" into a checked claim.
import { isCommandLineRuntimeOwner } from '../../../local-runtime-v2/src/application/agent/profile-source.js';
import { ownsElectronRuntimeCapabilities } from '../../../local-runtime-v2/src/application/agent/runtime-browser-use-composition.js';

/** Every value a client can pass as `runtimeOwnerKind`, plus the absent case. */
const OWNER_INPUTS = [
  undefined,
  'electron',
  'cli',
  'tui',
  'runtime',
  // Not a union member anywhere. It exists only in
  // local-output-safety-writer-v2-guide-review.test.ts and resolves through the
  // unknown-owner guard, so the guard's answer is a behaviour change for it.
  'test',
  'webui',
  'some-future-client',
] as const;

const cliEmbeddedValues = [true, false] as const;
const electronHostValues = [true, false] as const;
const capabilityProfileValues = ['cli', undefined] as const;

/** The full input space the host factory can produce. */
const INPUT_SPACE = OWNER_INPUTS.flatMap((kind) =>
  cliEmbeddedValues.flatMap((cliEmbedded) =>
    electronHostValues.flatMap((electronHost) =>
      capabilityProfileValues.map((capabilityProfile) => ({
        kind,
        cliEmbedded,
        electronHost,
        capabilityProfile,
      })),
    ),
  ),
);

function policyFor(input: {
  readonly kind: string | undefined;
  readonly cliEmbedded: boolean;
  readonly electronHost: boolean;
  readonly capabilityProfile: 'cli' | undefined;
}): RuntimeOwnerPolicy {
  return resolveRuntimeOwnerPolicy(input);
}

describe("today's predicates", () => {
  it('isCommandLineRuntimeOwner accepts cli and tui only, and rejects undefined', () => {
    expect(isCommandLineRuntimeOwner('cli')).toBe(true);
    expect(isCommandLineRuntimeOwner('tui')).toBe(true);
    expect(isCommandLineRuntimeOwner(undefined)).toBe(false);
    expect(isCommandLineRuntimeOwner('electron')).toBe(false);
    expect(isCommandLineRuntimeOwner('runtime')).toBe(false);
    expect(isCommandLineRuntimeOwner('test')).toBe(false);
  });

  it('ownsElectronRuntimeCapabilities accepts undefined, which is not the same answer', () => {
    // The asymmetry with isCommandLineRuntimeOwner is the defect, not a detail: the
    // same missing value reads as desktop here and as unknown there.
    expect(ownsElectronRuntimeCapabilities(undefined)).toBe(true);
    expect(ownsElectronRuntimeCapabilities('electron')).toBe(true);
    expect(ownsElectronRuntimeCapabilities('cli')).toBe(false);
    expect(ownsElectronRuntimeCapabilities('tui')).toBe(false);
    expect(ownsElectronRuntimeCapabilities('runtime')).toBe(false);
    expect(ownsElectronRuntimeCapabilities('test')).toBe(false);
  });

  it('isCliRestrictedRuntime requires cliEmbedded, unlike isCommandLineRuntimeOwner', () => {
    expect(isCliRestrictedRuntime('cli', true)).toBe(true);
    expect(isCliRestrictedRuntime('tui', true)).toBe(true);
    expect(isCliRestrictedRuntime('cli', false)).toBe(false);
    expect(isCliRestrictedRuntime('tui', false)).toBe(false);
    expect(isCliRestrictedRuntime('electron', true)).toBe(false);
    expect(isCliRestrictedRuntime('runtime', true)).toBe(false);
  });
});

describe('resolveRuntimeOwnerPolicy', () => {
  it('reports kind as "runtime" for an absent owner, without merging the rows', () => {
    const policy = policyFor({
      kind: undefined,
      cliEmbedded: false,
      electronHost: false,
      capabilityProfile: undefined,
    });
    expect(policy.kind).toBe('runtime');
    expect(policy.wiring.ownsV2Runtime).toBe(false);
    // services.ts:493,499 read the RAW option, so an absent owner gets cron and
    // channel. An earlier draft of the row said false and reasoned from the coerced
    // string at host.ts:708 instead.
    expect(policy.wiring.cronService).toBe(true);
    expect(policy.wiring.channelService).toBe(true);
    expect(policy.wiring.browserActivation).toBe('desktop-plugin');
    expect(policy.wiring.schedulerHost).toBe(false);
    expect(policy.execution.restricted).toBe(false);
    expect(policy.execution.memoryFeature).toBe(true);
    expect(policy.execution.mavisFeatureBundle).toBe(true);
    expect(policy.execution.reviewPolicy).toBe('neither');
    expect(policy.execution.executesTerminalControl).toBe(false);
    expect(policy.execution.promptProfile).toBe('desktop');
    expect(policy.execution.promptSurfaceDefault).toBe('interactive');
    expect(policy.execution.titleSafetyBypass).toBe(false);
  });

  it('names every cell for every known row', () => {
    for (const input of INPUT_SPACE) {
      const policy = policyFor(input);
      expect(Object.keys(policy.wiring).sort()).toEqual([
        'browserActivation',
        'channelService',
        'cronService',
        'ownsV2Runtime',
        'schedulerHost',
      ]);
      expect(Object.keys(policy.execution).sort()).toEqual([
        'executesTerminalControl',
        'mavisFeatureBundle',
        'memoryFeature',
        'promptProfile',
        'promptSurfaceDefault',
        'restricted',
        'reviewPolicy',
        'titleSafetyBypass',
      ]);
    }
  });

  it('every cell has a defined value across the whole input space', () => {
    // A guard that leaves cells unspecified is the same defect one level down, so the
    // guard is asserted per cell rather than by comparing to an expected object.
    for (const input of INPUT_SPACE) {
      const { wiring, execution } = policyFor(input);
      for (const [name, value] of Object.entries(wiring)) {
        expect(value, `wiring.${name} for ${String(input.kind)}`).toBeDefined();
      }
      for (const [name, value] of Object.entries(execution)) {
        expect(value, `execution.${name} for ${String(input.kind)}`).toBeDefined();
      }
    }
  });

  it("fails closed on grants and open on wiring for an unrecognised owner", () => {
    const policy = policyFor({
      kind: 'test',
      cliEmbedded: false,
      electronHost: false,
      capabilityProfile: undefined,
    });
    expect(policy.kind).toBe('test');
    expect(policy.wiring.ownsV2Runtime).toBe(true);
    expect(policy.wiring.schedulerHost).toBe(false);
    expect(policy.wiring.cronService).toBe(false);
    expect(policy.wiring.channelService).toBe(false);
    expect(policy.wiring.browserActivation).toBe('explicit-config');
    expect(policy.execution.restricted).toBe(true);
    expect(policy.execution.memoryFeature).toBe(false);
    expect(policy.execution.mavisFeatureBundle).toBe(false);
    expect(policy.execution.reviewPolicy).toBe('neither');
    expect(policy.execution.executesTerminalControl).toBe(false);
    expect(policy.execution.promptProfile).toBe('desktop');
    expect(policy.execution.promptSurfaceDefault).toBe('interactive');
    expect(policy.execution.titleSafetyBypass).toBe(false);
  });

  it("'test' differs from today's predicates, and the difference is deliberate", () => {
    const policy = policyFor({
      kind: 'test',
      cliEmbedded: false,
      electronHost: false,
      capabilityProfile: undefined,
    });
    // Today: ownsV2Runtime false, memory granted, restricted false.
    expect(policy.wiring.ownsV2Runtime).toBe(true);
    expect(policy.execution.memoryFeature).toBe(false);
    expect(policy.execution.restricted).toBe(true);
  });

  it('keeps an unrecognised owner uniform across host configuration', () => {
    // The guard must not accidentally re-open a grant when cliEmbedded or
    // electronHost is true.
    const base = { kind: 'some-future-client', capabilityProfile: undefined } as const;
    for (const cliEmbedded of cliEmbeddedValues) {
      for (const electronHost of electronHostValues) {
        const policy = policyFor({ ...base, cliEmbedded, electronHost });
        expect(policy.execution.memoryFeature).toBe(false);
        expect(policy.execution.restricted).toBe(true);
        expect(policy.wiring.cronService).toBe(false);
        expect(policy.wiring.channelService).toBe(false);
      }
    }
  });

  it('electron owns the desktop service surface and the V2 compatibility layer', () => {
    const policy = policyFor({
      kind: 'electron',
      cliEmbedded: true,
      electronHost: true,
      capabilityProfile: undefined,
    });
    expect(policy.wiring.ownsV2Runtime).toBe(true);
    expect(policy.wiring.schedulerHost).toBe(true);
    expect(policy.wiring.cronService).toBe(true);
    expect(policy.wiring.channelService).toBe(true);
    expect(policy.wiring.browserActivation).toBe('desktop-plugin');
    expect(policy.execution.restricted).toBe(false);
    expect(policy.execution.memoryFeature).toBe(true);
    expect(policy.execution.mavisFeatureBundle).toBe(true);
    expect(policy.execution.reviewPolicy).toBe('neither');
    expect(policy.execution.promptProfile).toBe('desktop');
    expect(policy.execution.promptSurfaceDefault).toBe('interactive');
    expect(policy.execution.titleSafetyBypass).toBe(false);
  });

  it('electron without electronHost does not hold the V2 compatibility layer', () => {
    // This is the failure ADR 0012 records: declaring an Electron owner without the
    // capability removes the whole v2 service group.
    const policy = policyFor({
      kind: 'electron',
      cliEmbedded: false,
      electronHost: false,
      capabilityProfile: undefined,
    });
    expect(policy.wiring.ownsV2Runtime).toBe(false);
    expect(policy.wiring.schedulerHost).toBe(true);
    expect(policy.wiring.cronService).toBe(true);
  });

  it('cli and tui are restricted only when embedded', () => {
    for (const kind of ['cli', 'tui'] as const) {
      const embedded = policyFor({
        kind,
        cliEmbedded: true,
        electronHost: false,
        capabilityProfile: 'cli',
      });
      expect(embedded.execution.restricted).toBe(true);
      // Only 'tui' is denied memory by owner kind. 'cli' is stopped by `restricted`,
      // which is what drives disableMemory — a different mechanism.
      expect(embedded.execution.memoryFeature).toBe(kind !== 'tui');
      expect(embedded.execution.mavisFeatureBundle).toBe(false);
      expect(embedded.wiring.ownsV2Runtime).toBe(true);
      expect(embedded.wiring.cronService).toBe(false);
      expect(embedded.wiring.channelService).toBe(false);
      expect(embedded.execution.executesTerminalControl).toBe(kind === 'tui');
      expect(embedded.execution.reviewPolicy).toBe(kind === 'tui' ? 'tui' : 'cli');
      expect(embedded.execution.titleSafetyBypass).toBe(true);
      expect(embedded.execution.promptProfile).toBe(kind === 'tui' ? 'tui' : 'desktop');
      expect(embedded.execution.promptSurfaceDefault).toBe('cli');

      const notEmbedded = policyFor({
        kind,
        cliEmbedded: false,
        electronHost: false,
        capabilityProfile: 'cli',
      });
      expect(notEmbedded.execution.restricted).toBe(false);
      expect(notEmbedded.wiring.ownsV2Runtime).toBe(false);
      // An unembedded cli/tui owner keeps the memory gate open — matching today.
      expect(notEmbedded.execution.memoryFeature).toBe(kind !== 'tui');
    }
  });

  it('runtime is an explicit row that grants memory but no services', () => {
    const policy = policyFor({
      kind: 'runtime',
      cliEmbedded: true,
      electronHost: true,
      capabilityProfile: undefined,
    });
    // Distinct from 'absent' even though both report kind "runtime" for diagnostics
    // purposes: the raw option here is a real string, so no gate reads undefined.
    expect(policy.wiring.ownsV2Runtime).toBe(false);
    expect(policy.wiring.cronService).toBe(false);
    expect(policy.wiring.channelService).toBe(false);
    expect(policy.wiring.browserActivation).toBe('explicit-config');
    expect(policy.execution.restricted).toBe(false);
    expect(policy.execution.memoryFeature).toBe(true);
    expect(policy.execution.mavisFeatureBundle).toBe(true);
  });

  it("'webui' resolves to its own row, which differs from tui in six cells", () => {
    // Read as "where WebUI differs from tui": seven cells are inherited so an
    // identity change does not silently move turn-execution semantics.
    //
    // Compared as the two clients actually declare today: `tui` still carries
    // capabilityProfile 'cli', while the webui row sets mavisFeatureBundle explicitly.
    // That is why it is one of the six differences rather than an inherited cell.
    const webui = policyFor({
      kind: 'webui',
      cliEmbedded: true,
      electronHost: false,
      capabilityProfile: 'cli',
    });
    const tui = policyFor({
      kind: 'tui',
      cliEmbedded: true,
      electronHost: false,
      capabilityProfile: 'cli',
    });
    expect(webui.kind).toBe('webui');
    const differing = (['wiring', 'execution'] as const).flatMap((group) =>
      Object.keys(tui[group])
        .filter((cell) => tui[group][cell] !== webui[group][cell])
        .map((cell) => `${group}.${cell}`),
    );
    expect(differing.sort()).toEqual(
      [
        'execution.executesTerminalControl',
        'execution.mavisFeatureBundle',
        'execution.memoryFeature',
        'execution.restricted',
        'wiring.cronService',
        'wiring.schedulerHost',
      ].sort(),
    );
    // The six differences themselves, asserted so the count is not the only check.
    expect(webui.wiring.ownsV2Runtime).toBe(true);
    expect(webui.wiring.schedulerHost).toBe(true);
    expect(webui.wiring.cronService).toBe(true);
    expect(webui.wiring.channelService).toBe(false);
    expect(webui.wiring.browserActivation).toBe('explicit-config');
    expect(webui.execution.restricted).toBe(false);
    expect(webui.execution.memoryFeature).toBe(true);
    expect(webui.execution.mavisFeatureBundle).toBe(true);
    expect(webui.execution.reviewPolicy).toBe('tui');
    // WebUI inherits the TUI review policy but is told it cannot run terminal control.
    expect(webui.execution.promptProfile).toBe('tui');
    expect(webui.execution.promptSurfaceDefault).toBe('cli');
    expect(webui.execution.titleSafetyBypass).toBe(true);
  });

  it('no longer routes webui through the unknown-owner guard', () => {
    const webui = policyFor({
      kind: 'webui',
      cliEmbedded: true,
      electronHost: false,
      capabilityProfile: undefined,
    });
    const unknown = policyFor({
      kind: 'some-future-client',
      cliEmbedded: true,
      electronHost: false,
      capabilityProfile: undefined,
    });
    expect(webui.execution.memoryFeature).not.toBe(unknown.execution.memoryFeature);
    expect(webui.wiring.cronService).not.toBe(unknown.wiring.cronService);
  });

  it('exposes RuntimeOwnerKind as a closed union and rejects undeclared rows', () => {
    // RuntimeOwnerKind is only sound if it cannot silently widen, so the module ships
    // a real exhaustiveness helper and the resolver's switch ends in it.
    expect(RUNTIME_OWNER_KINDS).toEqual(['electron', 'cli', 'tui', 'webui', 'runtime']);
    expect(isDeclaredRuntimeOwnerKind('electron')).toBe(true);
    expect(isDeclaredRuntimeOwnerKind('runtime')).toBe(true);
    expect(isDeclaredRuntimeOwnerKind('test')).toBe(false);
    expect(isDeclaredRuntimeOwnerKind(undefined as unknown as string)).toBe(false);
    // The never helper is what makes the resolver's switch total. Calling it with a
    // value outside the rows must throw rather than return a partial policy.
    expect(() => assertNeverRuntimeOwnerRow('absent-other' as never)).toThrow(
      /Undeclared runtime owner row/,
    );
  });

  it('treats absent as a row distinct from every named kind', () => {
    const ABSENT: RuntimeOwnerRow = 'absent';
    expect(ABSENT).toBe('absent');
    expect(policyFor({ kind: undefined, cliEmbedded: false, electronHost: false, capabilityProfile: undefined }).wiring)
      .not.toEqual(
        policyFor({ kind: 'runtime', cliEmbedded: false, electronHost: false, capabilityProfile: undefined }).wiring,
      );
  });
});
/**
 * Defects an independent review found in the first implementation pass.
 *
 * These are regression tests for real bugs, not restatements of the row table:
 *  - `promptSurfaceDefault` was not threaded to two consumers, so a `webui` owner
 *    behaved as `interactive` while its policy row said `cli`.
 *  - The prompt-level memory/cron gates ignored policy, so an unrecognised owner
 *    was granted memory and cron in the prompt even though the guard denies both.
 */
describe('review-found defects', () => {
  it('resolveAgentPromptSurface honours the resolved cell for a webui owner', async () => {
    const { resolveAgentPromptSurface } = await import(
      '../../../local-runtime-v2/src/service/turn-system/agent-host/preparation/agent-prompt-surface.js'
    );
    const policy = policyFor({
      kind: 'webui',
      cliEmbedded: true,
      electronHost: false,
      capabilityProfile: undefined,
    });
    const session = { sessionType: 'primary', sessionKind: 'primary' };
    // Without the cell the helper's fallback recognises only cli/tui, so webui would
    // silently become `interactive` — the exact divergence the review found.
    expect(resolveAgentPromptSurface(session, 'webui')).toBe('interactive');
    expect(
      resolveAgentPromptSurface(session, 'webui', policy.execution.promptSurfaceDefault),
    ).toBe(policy.execution.promptSurfaceDefault);
    expect(policy.execution.promptSurfaceDefault).toBe('cli');
  });

  it('the policy denies memory and cron to an unrecognised owner', () => {
    // The gate that was bypassed composed only the owner-kind predicate, so these two
    // answers are what the prompt-level gates must now also honour.
    const policy = policyFor({
      kind: 'some-future-client',
      cliEmbedded: false,
      electronHost: false,
      capabilityProfile: undefined,
    });
    expect(policy.execution.memoryFeature).toBe(false);
    expect(policy.wiring.cronService).toBe(false);
  });

  it('keeps cronService in the wiring group and memoryFeature in the execution group', () => {
    // Reading the wrong group is a real mistake this change already made once.
    const policy = policyFor({
      kind: 'tui',
      cliEmbedded: true,
      electronHost: false,
      capabilityProfile: 'cli',
    });
    expect(policy.wiring).toHaveProperty('cronService');
    expect(policy.execution).not.toHaveProperty('cronService');
    expect(policy.execution).toHaveProperty('memoryFeature');
    expect(policy.wiring).not.toHaveProperty('memoryFeature');
  });
});
