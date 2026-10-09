/**
 * Runtime owner policy.
 *
 * `runtimeOwnerKind` is one string read by more than twenty call sites, each of which
 * decided independently what the value means. Three sites encode "am I a desktop",
 * two encode "am I a degraded runtime", and neither set is a subset of the other. An
 * unrecognised value therefore lands in a bucket nobody designed: it drops the V1
 * compatibility layer (`runtime.ts`) while silently granting memory (`host.ts`) and
 * cron (`services.ts`).
 *
 * This module names every decision once. It resolves an owner kind plus host
 * configuration into thirteen cells in two groups — `wiring`, what the host assembles
 * and exposes, and `execution`, how a turn behaves — because not redundant is not the
 * same as one concept. A consumer asking for a wiring cell should not also be handed
 * turn-execution semantics.
 *
 * **Phase 1 status: no call site reads this module.** It is a mechanical transcription
 * of the existing predicates, plus the unknown-owner guard, plus the `'absent'` row.
 * The guards against drift are in `test/unit/runtime-owner-policy.test.ts`, which pins
 * the current behaviour of the predicates this file is meant to replace.
 *
 * The grouping only holds if consumers use the right group. If a caller flattens the
 * descriptor, or rebuilds a value from `kind` instead of reading a cell, the two
 * groups become documentation.
 */

/**
 * Known owner kinds. `'runtime'` is the string `api/host.ts` substitutes for an
 * absent owner before storing it. It is a declared row, not a fallback, and it is
 * deliberately *not* the same thing as `'absent'` — see `resolveRuntimeOwnerPolicy`.
 */
export type RuntimeOwnerKind = 'electron' | 'cli' | 'tui' | 'webui' | 'runtime';

/**
 * Resolution rows. `'absent'` is distinct from `'runtime'` because the predicates
 * disagree about an absent owner today, and collapsing them would be a behaviour
 * change chosen by the word "normalisation".
 */
export type RuntimeOwnerRow = RuntimeOwnerKind | 'absent';

/**
 * The row a kind resolves to before it is known to be declared. A value outside the
 * union lands here and takes the unknown-owner posture.
 */
type UnresolvedRuntimeOwnerRow = RuntimeOwnerRow | 'unknown';

export const RUNTIME_OWNER_KINDS: readonly RuntimeOwnerKind[] = [
  'electron',
  'cli',
  'tui',
  'webui',
  'runtime',
];

/** What the host assembles and exposes. */
export interface RuntimeWiring {
  /** Replaces `isV2RuntimeOwner`. Gates the whole V1 compatibility layer. */
  readonly ownsV2Runtime: boolean;
  /** Replaces the inline `runtimeOwnerKind === 'electron'` scheduler gate. */
  readonly schedulerHost: boolean;
  /** Replaces `ownsElectronRuntimeCapabilities` at the `services.ts` cron gate. */
  readonly cronService: boolean;
  /**
   * One cell driving two sites. Channels are governed by two independent switches
   * today — owner kind (`services.ts`) and `capabilityProfile` (`host.ts` and
   * `host-channel-composition.ts`) — and dropping `capabilityProfile` while only one
   * site reads a cell silently enables channels.
   */
  readonly channelService: boolean;
  readonly browserActivation: 'desktop-plugin' | 'explicit-config';
}

/** How agent execution behaves. */
export interface AgentExecutionPolicy {
  /**
   * Replaces `isCliRestrictedRuntime`. Today indivisible: it drives `disableMemory`,
   * `disableCron` and `disableComputerUse` together from one branch.
   */
  readonly restricted: boolean;
  /**
   * The owner-kind memory gate only (`host.ts` denies memory for `'tui'`). The
   * background collector and the memory tool are separate mechanisms, and
   * `restricted` closes the tool independently of this cell.
   */
  readonly memoryFeature: boolean;
  /** Replaces `capabilityProfile === 'cli'` at both copies of the `mavis` gate. */
  readonly mavisFeatureBundle: boolean;
  /**
   * One decision with two consequences that today hang off the same flag on adjacent
   * lines of one call site: input review deferred (`executor.ts`) and content review
   * with unreviewed streaming when not required (`turn-execution-policy.ts`).
   */
  readonly reviewPolicy: 'tui' | 'cli' | 'neither';
  /**
   * Replaces `terminalSequenceSurface: 'tui'`. That field is a capability rather than
   * a label: `local-turn-plugin-hooks.ts` tests it with `=== 'tui'` and takes an
   * explanatory branch otherwise.
   */
  readonly executesTerminalControl: boolean;
  readonly promptProfile: 'desktop' | 'tui';
  readonly promptSurfaceDefault: 'interactive' | 'cli';
  /**
   * Skips content-safety review for generated titles under an unmanaged provider.
   * Provisional: carried as the current effective value so a refactor does not
   * silently change title generation. Whether the bypass is right depends on the
   * provider and trust assumptions, not on which client is asking.
   */
  readonly titleSafetyBypass: boolean;
}

export interface RuntimeOwnerPolicy {
  /**
   * Reporting label. `?? "runtime"` keeps metrics and diagnostics unchanged, even
   * though the *resolution row* for an absent owner differs.
   */
  readonly kind: string;
  readonly wiring: RuntimeWiring;
  readonly execution: AgentExecutionPolicy;
}

export interface ResolveRuntimeOwnerPolicyInput {
  readonly kind: string | undefined;
  readonly cliEmbedded: boolean;
  readonly electronHost: boolean;
  readonly capabilityProfile: 'cli' | undefined;
}

/** Compile-time exhaustiveness helper over the declared rows. */
export function assertNeverRuntimeOwnerRow(value: never): never {
  throw new Error(`Undeclared runtime owner row: ${String(value)}`);
}

/* -------------------------------------------------------------------------- */
/* Extracted predicates                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Whether this host holds the V2 compatibility layer.
 *
 * Extracted from `local-runtime-v2/src/runtime.ts`. The `cliEmbedded` /
 * `electronHost` pair is why a bare kind comparison is not enough: declaring an
 * Electron owner without the capability removes the whole v2 service group.
 */
export function isV2RuntimeOwner(
  kind: string | undefined,
  electronHost: boolean,
  cliEmbedded: boolean,
): boolean {
  return (
    (kind === 'electron' && electronHost === true) ||
    ((kind === 'cli' || kind === 'tui') && cliEmbedded === true)
  );
}

/**
 * Extracted from `runtime-browser-use-composition.ts`. It accepts `undefined` and
 * answers `true` there, which is the asymmetry behind the root defect: the same
 * missing value reads as "assume desktop" here and as "unknown" in
 * `isV2RuntimeOwner`.
 */
export function ownsElectronRuntimeCapabilities(kind: string | undefined): boolean {
  return kind === undefined || kind === 'electron';
}

/**
 * Extracted from `profile-source.ts`, where it is duplicated verbatim in
 * `task-agent-binding-capture.ts`. It does *not* require an embedded CLI, unlike
 * `isCliRestrictedRuntime` below; that divergence is the duplication's cost.
 */
export function isCommandLineRuntimeOwner(kind: string | undefined): boolean {
  return kind === 'cli' || kind === 'tui';
}

/**
 * Extracted from `api/hosted-agent-capability-factory.ts`, documented there as the
 * single source of truth for "this host is a restricted command-line runtime".
 */
export function isCliRestrictedRuntime(kind: string | undefined, cliEmbedded: boolean): boolean {
  return isCommandLineRuntimeOwner(kind) && cliEmbedded === true;
}

/* -------------------------------------------------------------------------- */
/* The resolver                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Fail-closed on grants, fail-open on wiring.
 *
 * For an owner outside the declared rows, memory, cron and channels are closed and
 * `restricted` is on, but `ownsV2Runtime` is **true** so an unknown client still gets
 * a working host rather than a broken one. Today the same unknown value drops the
 * compatibility layer while being granted memory and cron, which is not a posture
 * anyone chose.
 *
 * This is a deliberate compatibility decision, not a free safety win: for `'test'`,
 * which exists only in `local-output-safety-writer-v2-guide-review.test.ts`, the
 * answers genuinely change. The guard is inert until a call site reads it.
 */
const UNKNOWN_OWNER_POLICY: Omit<RuntimeOwnerPolicy, 'kind'> = {
  wiring: {
    ownsV2Runtime: true,
    schedulerHost: false,
    cronService: false,
    channelService: false,
    browserActivation: 'explicit-config',
  },
  execution: {
    restricted: true,
    memoryFeature: false,
    mavisFeatureBundle: false,
    reviewPolicy: 'neither',
    executesTerminalControl: false,
    promptProfile: 'desktop',
    promptSurfaceDefault: 'interactive',
    titleSafetyBypass: false,
  },
};

/**
 * Resolve one owner kind plus host configuration into the policy the harness applies.
 *
 * Every input is consumed by a returned cell, or it does not belong here:
 *
 *   cliEmbedded       -> wiring.ownsV2Runtime, execution.restricted
 *   electronHost      -> wiring.ownsV2Runtime
 *   capabilityProfile -> wiring.channelService, execution.mavisFeatureBundle
 *
 * `'absent'` is a resolution row distinct from `'runtime'`. `ownsElectronRuntimeCapabilities`
 * and `isV2RuntimeOwner` answer differently for an absent owner, and
 * `api/host.ts` coerces the stored kind to `"runtime"` while `services.ts` keeps
 * reading the raw option. An undeclared owner therefore receives the entire desktop
 * service surface plus the memory collector, and loses only the compatibility layer.
 * That incoherence is transcribed here rather than fixed: fixing it is a behaviour
 * change, and it is a named follow-up.
 *
 * `'webui'` is the maintainer-decided row, verified by a test that constructs a real
 * host with it rather than by asserting the shape of a table.
 */
export function resolveRuntimeOwnerPolicy(
  input: ResolveRuntimeOwnerPolicyInput,
): RuntimeOwnerPolicy {
  const { kind, cliEmbedded, electronHost, capabilityProfile } = input;
  // host.ts stores `runtimeOwnerKind ?? "runtime"` for metrics and diagnostics, so the
  // reported label is unchanged by any row below.
  const reportedKind = kind ?? 'runtime';

  const row: UnresolvedRuntimeOwnerRow =
    kind === undefined ? 'absent' : isDeclaredRuntimeOwnerKind(kind) ? kind : 'unknown';

  switch (row) {
    case 'electron':
      return {
        kind: reportedKind,
        wiring: {
          ownsV2Runtime: isV2RuntimeOwner(kind, electronHost, cliEmbedded),
          schedulerHost: true,
          cronService: ownsElectronRuntimeCapabilities(kind),
          channelService:
            ownsElectronRuntimeCapabilities(kind) && capabilityProfile !== 'cli',
          browserActivation: ownsElectronRuntimeCapabilities(kind)
            ? 'desktop-plugin'
            : 'explicit-config',
        },
        execution: {
          restricted: isCliRestrictedRuntime(kind, cliEmbedded),
          memoryFeature: true,
          mavisFeatureBundle: capabilityProfile !== 'cli',
          reviewPolicy: 'neither',
          executesTerminalControl: false,
          promptProfile: 'desktop',
          promptSurfaceDefault: 'interactive',
          titleSafetyBypass: false,
        },
      };
    case 'cli':
    case 'tui':
      return {
        kind: reportedKind,
        wiring: {
          ownsV2Runtime: isV2RuntimeOwner(kind, electronHost, cliEmbedded),
          schedulerHost: false,
          cronService: ownsElectronRuntimeCapabilities(kind),
          channelService:
            ownsElectronRuntimeCapabilities(kind) && capabilityProfile !== 'cli',
          browserActivation: ownsElectronRuntimeCapabilities(kind)
            ? 'desktop-plugin'
            : 'explicit-config',
        },
        execution: {
          restricted: isCliRestrictedRuntime(kind, cliEmbedded),
          // Only 'tui' is denied memory by owner kind. 'cli' is stopped later, by
          // `restricted` -> disableMemory.
          memoryFeature: kind !== 'tui',
          mavisFeatureBundle: capabilityProfile !== 'cli',
          // The tui branch returns first, so a tui owner that is also a
          // command-line owner still resolves to the tui policy.
          reviewPolicy: kind === 'tui' ? 'tui' : 'cli',
          executesTerminalControl: kind === 'tui',
          promptProfile: kind === 'tui' ? 'tui' : 'desktop',
          promptSurfaceDefault: isCommandLineRuntimeOwner(kind) ? 'cli' : 'interactive',
          titleSafetyBypass: true,
        },
      };
    case 'runtime':
      return {
        kind: reportedKind,
        wiring: {
          ownsV2Runtime: isV2RuntimeOwner(kind, electronHost, cliEmbedded),
          schedulerHost: false,
          cronService: ownsElectronRuntimeCapabilities(kind),
          channelService:
            ownsElectronRuntimeCapabilities(kind) && capabilityProfile !== 'cli',
          browserActivation: ownsElectronRuntimeCapabilities(kind)
            ? 'desktop-plugin'
            : 'explicit-config',
        },
        execution: {
          restricted: isCliRestrictedRuntime(kind, cliEmbedded),
          memoryFeature: true,
          mavisFeatureBundle: capabilityProfile !== 'cli',
          reviewPolicy: 'neither',
          executesTerminalControl: false,
          promptProfile: 'desktop',
          promptSurfaceDefault: 'interactive',
          titleSafetyBypass: false,
        },
      };
    case 'absent':
      return {
        kind: reportedKind,
        wiring: {
          // The raw option is undefined, so the compatibility gate rejects it.
          ownsV2Runtime: isV2RuntimeOwner(kind, electronHost, cliEmbedded),
          schedulerHost: false,
          // ...while these read the raw undefined and answer true.
          cronService: ownsElectronRuntimeCapabilities(kind),
          channelService:
            ownsElectronRuntimeCapabilities(kind) && capabilityProfile !== 'cli',
          browserActivation: ownsElectronRuntimeCapabilities(kind)
            ? 'desktop-plugin'
            : 'explicit-config',
        },
        execution: {
          restricted: isCliRestrictedRuntime(kind, cliEmbedded),
          memoryFeature: true,
          mavisFeatureBundle: capabilityProfile !== 'cli',
          reviewPolicy: 'neither',
          executesTerminalControl: false,
          promptProfile: 'desktop',
          promptSurfaceDefault: 'interactive',
          titleSafetyBypass: false,
        },
      };
    case 'webui':
      // The maintainer-decided row. Read as "where WebUI differs from tui": it is the
      // tui row with six cells changed. The inherited cells are the default and the
      // six differences are the proposal, because an identity change must not silently
      // move turn-execution semantics.
      return {
        kind: reportedKind,
        wiring: {
          // Explicit, not inherited: `tui` gets ownsV2Runtime from a `cli || tui`
          // clause that `webui` is not in. Dropping it removes the V1 compatibility
          // layer and with it the questionnaire service.
          ownsV2Runtime: isV2RuntimeOwner('tui', electronHost, cliEmbedded),
          schedulerHost: true,
          cronService: true,
          channelService: false,
          browserActivation: 'explicit-config',
        },
        execution: {
          restricted: false,
          memoryFeature: true,
          mavisFeatureBundle: true,
          reviewPolicy: 'tui',
          // Changed at the flip: WebUI inherits 'tui' today and is therefore told it
          // executes terminal control sequences, which a browser client cannot run.
          executesTerminalControl: false,
          promptProfile: 'tui',
          promptSurfaceDefault: 'cli',
          // Provisional, carried as today's effective value so the refactor does not
          // silently change title generation. See AgentExecutionPolicy.
          titleSafetyBypass: true,
        },
      };
    case 'unknown':
      return { kind: reportedKind, ...UNKNOWN_OWNER_POLICY };
    default:
      return assertNeverRuntimeOwnerRow(row as never);
  }
}

export function isDeclaredRuntimeOwnerKind(kind: string): kind is RuntimeOwnerKind {
  return (RUNTIME_OWNER_KINDS as readonly string[]).includes(kind);
}