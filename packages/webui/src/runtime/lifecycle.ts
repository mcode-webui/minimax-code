// The WebUI runtime's one close owner and its startup-failure cleanup. Split
// out of `runtime/assembly.ts`: resource registration, failure recovery, close
// ordering, idempotent close.
//
// Exactly one module wraps the host's `close()`. The assembly registers the
// bound host close and installs this lifecycle's `close` in its place, so the
// harness host is torn down once, followed by the mcode-tools broker and the
// externally supplied browser provider, in the close order
// `packages/webui/docs/runtime/boot.md` states. The same wrapper is reused for the
// post-host startup failure, so a broker socket or a Browser profile never
// survives a WebUI start that failed after the host was built.
//
// The pre-host failure path releases every owner acquired before the factory
// returns an apiHost, including auth.

export interface WebuiRuntimeResourceOwners {
  /** Stops the auth watch and clears the refresh timer. Runs first on close. */
  readonly disposeAuth: () => void;
  /** Disposes the mcode-tools broker. */
  readonly disposeMcodeTools: () => Promise<void>;
  /** Releases the externally supplied browser provider, when one exists. */
  readonly closeBrowserProvider?: () => void | Promise<void>;
}

export interface WebuiRuntimeLifecycle {
  readonly registerShutdownResource: (dispose: () => Promise<void>) => void;
  /**
   * Registers the bound harness-host close. Called once, when the factory
   * returns the host; `close` runs it after the auth teardown.
   */
  readonly registerHostClose: (close: () => Promise<void>) => void;
  /**
   * Idempotent overall close owner. Order: auth teardown, harness host,
   * mcode-tools broker, browser provider. Collects every failure and throws the
   * single error, or an `AggregateError` when more than one owner failed.
   */
  readonly close: () => Promise<void>;
  /**
   * Startup-failure path used before a host exists: releases the acquired
   * capability owners (auth, mcode-tools broker, browser provider) and throws the
   * single error, or an `AggregateError`, labelled as a startup failure.
   */
  readonly closeAcquiredResources: () => Promise<void>;
}

export function createWebuiRuntimeLifecycle(
  owners: WebuiRuntimeResourceOwners,
): WebuiRuntimeLifecycle {
  let hostClose: (() => Promise<void>) | undefined;
  /** One completion and failure outcome for all close callers. */
  let closing: Promise<void> | undefined;
  const resources: (() => Promise<void>)[] = [];
  const closeOwners = async (): Promise<void> => {
    const failures: unknown[] = [];
    for (const dispose of resources.splice(0)) {
      try { await dispose(); } catch (error) { failures.push(error); }
    }
    try {
      owners.disposeAuth();
    } catch (error) {
      failures.push(error);
    }
    try {
      await hostClose?.();
    } catch (error) {
      failures.push(error);
    }
    try {
      await owners.disposeMcodeTools();
    } catch (error) {
      failures.push(error);
    }
    try {
      await owners.closeBrowserProvider?.();
    } catch (error) {
      failures.push(error);
    }
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1)
      throw new AggregateError(failures, "WebUI runtime shutdown failed");
  };
  const close = (): Promise<void> => {
    closing ??= Promise.resolve().then(closeOwners);
    return closing;
  };
  const closeAcquiredResources = async (): Promise<void> => {
    const failures: unknown[] = [];
    for (const dispose of resources.splice(0)) {
      try { await dispose(); } catch (error) { failures.push(error); }
    }
    try {
      owners.disposeAuth();
    } catch (error) {
      failures.push(error);
    }
    try {
      await owners.disposeMcodeTools();
    } catch (error) {
      failures.push(error);
    }
    try {
      await owners.closeBrowserProvider?.();
    } catch (error) {
      failures.push(error);
    }
    if (failures.length === 1) throw failures[0];
    throw new AggregateError(failures, "WebUI runtime startup failed");
  };
  return {
    registerShutdownResource(dispose) {
      if (closing) throw new Error("WebUI runtime is closed");
      resources.push(dispose);
    },
    registerHostClose(close_) {
      hostClose = close_;
    },
    close,
    closeAcquiredResources,
  };
}
