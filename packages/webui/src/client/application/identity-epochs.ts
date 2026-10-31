// The opaque identity/freshness context.
//
// A query answer's freshness depends on more than the parameters the caller
// typed: it depends on whether the credentials behind it were replaced, or the
// configuration it was computed under was changed. The resource key carries
// those as *opaque credential/config generations*, and this module is where
// those generations live.
//
// Three properties make it safe to hand to every owner:
//
//   * **Opaque.** A token is an instance-scoped counter string. It never carries
//     a credential, a lease or a config value, so it can appear in a key, a log
//     line or a test without disclosing anything; the values themselves stay in
//     the runtime.
//   * **Per instance.** Tokens embed the application instance's own opaque id,
//     so two instances never produce equal tokens even at the same generation.
//     A remount that builds a fresh assembly therefore cannot accept an answer
//     captured by the previous one — the "fresh epochs for fresh instances"
//     requirement, made structural rather than conventional.
//   * **Advance-only.** `advance` moves a generation forward and nothing else;
//     there is no way to set a generation back, so a late answer captured before
//     a write can never be made current again by a second write.
//
// The contract is deliberately small: owners read a token, put it in a key,
// compare with `isCurrent`, and call `advance` when a write invalidates answers.
// The *policy* — which commands advance which epoch — belongs to the owning
// business, not here.

/** The three generations an answer can depend on. */
export type WebuiEpochKey = "application" | "credentials" | "configuration";

/**
 * One opaque generation token. `key` and `generation` are for diagnostics;
 * `token` is what a resource key or a captured answer carries, and it is the
 * only field a comparison needs.
 */
export interface WebuiOpaqueEpoch {
  readonly key: WebuiEpochKey;
  readonly generation: number;
  readonly token: string;
}

export interface WebuiIdentityEpochs {
  /** The application instance's own epoch: fixed for the instance's lifetime. */
  readonly application: () => WebuiOpaqueEpoch;
  /** The credential generation: advances on sign-in/out and credential writes. */
  readonly credentials: () => WebuiOpaqueEpoch;
  /** The configuration generation: advances on provider/model/settings writes. */
  readonly configuration: () => WebuiOpaqueEpoch;
  /** Reads one by key. */
  readonly read: (key: WebuiEpochKey) => WebuiOpaqueEpoch;
  /**
   * Moves one generation forward and returns the new token. Call it from the
   * command that invalidates the answers — after the write succeeded, so a
   * failed mutation does not retire answers that are still true.
   */
  readonly advance: (key: WebuiEpochKey) => WebuiOpaqueEpoch;
  /**
   * True when the token is still the current generation of its key *and* belongs
   * to this instance. A captured answer is committed only when this holds.
   */
  readonly isCurrent: (epoch: WebuiOpaqueEpoch) => boolean;
  /** Subscribe to advances; the listener receives the epoch that moved. */
  readonly subscribe: (listener: (epoch: WebuiOpaqueEpoch) => void) => () => void;
}

/** The instance id a token embeds; unique per assembly, never a secret. */
let instanceCounter = 0;

function newInstanceId(): string {
  instanceCounter += 1;
  return `app${instanceCounter}`;
}

export function createWebuiIdentityEpochs(): WebuiIdentityEpochs {
  const instanceId = newInstanceId();
  const generations: Record<WebuiEpochKey, number> = {
    application: 0,
    credentials: 0,
    configuration: 0,
  };
  const listeners = new Set<(epoch: WebuiOpaqueEpoch) => void>();

  const token = (key: WebuiEpochKey): string =>
    `${instanceId}.${key}.${generations[key]}`;

  const read = (key: WebuiEpochKey): WebuiOpaqueEpoch => ({
    key,
    generation: generations[key],
    token: token(key),
  });

  return {
    application: () => read("application"),
    credentials: () => read("credentials"),
    configuration: () => read("configuration"),
    read,
    advance: (key) => {
      generations[key] += 1;
      const epoch = read(key);
      for (const listener of [...listeners]) listener(epoch);
      return epoch;
    },
    isCurrent: (epoch) => epoch.token === token(epoch.key),
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
