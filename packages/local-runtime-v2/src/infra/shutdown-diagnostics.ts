/** Phase markers for a host whose shutdown deadline expires before it returns. */
export function traceRuntimeShutdownPhase(phase: string): void {
  if (process.env.MCODE_RUNTIME_SHUTDOWN_DIAGNOSTICS !== "1") return;
  process.stderr.write(`[runtime-shutdown] ${phase}\n`);
}
