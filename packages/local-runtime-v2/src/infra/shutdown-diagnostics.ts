import { writeSync } from "node:fs";

/** Phase markers for a host whose shutdown deadline expires before it returns. */
export function traceRuntimeShutdownPhase(phase: string): void {
  if (process.env.MCODE_RUNTIME_SHUTDOWN_DIAGNOSTICS !== "1") return;
  // The next native call may block this process before an asynchronous write
  // flushes to the parent. Diagnostics must not change the shutdown outcome.
  try {
    writeSync(2, `[runtime-shutdown] ${phase} (uptime ${process.uptime().toFixed(3)}s)\n`);
  } catch {
    // The parent may already have closed the diagnostics pipe.
  }
}
