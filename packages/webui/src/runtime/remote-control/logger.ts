// The bridge's log sink.
//
// The bridge logs a lot — every phase transition, every connection attempt, every command — and
// none of it may carry a secret. The bridge's own call sites are careful (the pairing client
// reports `jwt=present(812chars)`, the audit-redaction module prints a binding digest), but the
// WebUI adds one more layer: a JWT-shaped substring that reaches a log line through a path the
// bridge does not own is redacted here rather than trusted away.
//
// The sink is the WebUI's own console convention (`console.info` / `warn` / `error`), not the
// bridge's: the bridge is host-neutral and knows nothing about how a host records a line.
import type { RcLogger } from "./bridge/types.js";

/**
 * A JWT, and the opaque long tokens a one-shot ticket can look like.
 *
 * The bridge never logs a ticket or a JWT on purpose; this pattern is the last line of defence
 * for the paths the bridge does not own (a host error message, a runtime error string).
 */
const SECRET_PATTERN = /\beyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\b/gu;

/** Replaces every JWT-shaped substring with a marker that says a secret was there. */
export function redactRemoteControlSecrets(message: string): string {
  return message.replace(SECRET_PATTERN, "[redacted]");
}

export interface RemoteControlLoggerOptions {
  /** Prefix every line carries, so a bridge line is findable in a host log. */
  readonly prefix?: string;
  /** When false, `debug` and `info` lines are dropped. */
  readonly verbose?: boolean;
  /** The sink; overridable so a test can capture the lines. */
  readonly write?: (level: "debug" | "info" | "warn" | "error", line: string) => void;
}

const DEFAULT_PREFIX = "[webui.rc]";

/**
 * The bridge's `RcLogger`.
 *
 * `debug` and `info` are dropped unless the host asked for them: the bridge is chatty by design
 * (it logs every frame count), and a service that prints a line per command makes the real
 * failures hard to find. `warn` and `error` always go through.
 */
export function createRemoteControlLogger(
  options: RemoteControlLoggerOptions = {},
): RcLogger {
  const prefix = options.prefix ?? DEFAULT_PREFIX;
  const verbose = options.verbose ?? false;
  const write =
    options.write ??
    ((level, line) => {
      if (level === "error") console.error(line);
      else if (level === "warn") console.warn(line);
      else console.info(line);
    });
  const emit = (level: "debug" | "info" | "warn" | "error", message: string): void => {
    if (!verbose && (level === "debug" || level === "info")) return;
    write(level, `${prefix} ${redactRemoteControlSecrets(message)}`);
  };
  return {
    debug: (message) => emit("debug", message),
    info: (message) => emit("info", message),
    warn: (message) => emit("warn", message),
    error: (message) => emit("error", message),
  };
}
