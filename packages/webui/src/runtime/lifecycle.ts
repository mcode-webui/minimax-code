// The WebUI runtime's one close owner and its startup-failure cleanup. Split
// out of `server/assembly.ts` (plan section 7.1: resource registration, failure
// recovery, close ordering, idempotent close).
//
// Exactly one module wraps the host's `close()`. The assembly registers the
// bound host close and installs this lifecycle's `close` in its place, so the
// harness host is torn down once, followed by the mcode-tools broker and the
// externally supplied browser provider, in the order step 13 of
// `docs/webui-v1-scope.md` requires. The same wrapper is reused for the
// post-host startup failure, so a broker socket or a Browser profile never
// survives a WebUI start that failed after the host was built.
//
// The pre-host failure path is deliberately narrower: when the factory throws
// before it returns an apiHost, only the resources already acquired are
// released. That is the exact behavior the assembly had, kept here so both
// paths are one implementation instead of two.

export interface WebuiRuntimeResourceOwners {
  /** Stops the auth watch and clears the refresh timer. Runs first on close. */
  readonly disposeAuth: () => void;
  /** Disposes the mcode-tools broker. */
  readonly disposeMcodeTools: () => Promise<void>;
  /** Releases the externally supplied browser provider, when one exists. */
  readonly closeBrowserProvider?: () => void | Promise<void>;
}

export interface WebuiRuntimeLifecycle {
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
   * capability owners (mcode-tools broker, browser provider) and throws the
   * single error, or an `AggregateError`, labelled as a startup failure.
   */
  readonly closeAcquiredResources: () => Promise<void>;
}

export function createWebuiRuntimeLifecycle(
  owners: WebuiRuntimeResourceOwners,
): WebuiRuntimeLifecycle {
  let hostClose: (() => Promise<void>) | undefined;
  let closed = false;
  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    const failures: unknown[] = [];
    owners.disposeAuth();
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
  const closeAcquiredResources = async (): Promise<void> => {
    const failures: unknown[] = [];
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
    registerHostClose(close_) {
      hostClose = close_;
    },
    close,
    closeAcquiredResources,
  };
}
