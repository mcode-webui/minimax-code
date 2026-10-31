// How a quota-reset instant reads in the usage menu.
//
// Carved out of `components/account/UserMenuUsage.tsx` by Phase 4b: the derivation moves to the
// layer that already owns the concept instead of riding along in the
// component that renders it. What moves is
// **1 declaration**, 1 function.
//
// The text below is the declaration as it stood in the source module — no
// behaviour change.

/**
 * Formats a quota reset timestamp:
 * `3小时13分后重置` below a day, `5天7小时后重置` once days are involved,
 * `13分后重置` below an hour. A past or invalid timestamp renders nothing.
 */
export function formatUsageResetLabel(
  resetAtMs: number | undefined,
  nowMs: number = Date.now(),
): string | undefined {
  if (resetAtMs === undefined) return undefined;
  const delta = resetAtMs - nowMs;
  if (!Number.isFinite(delta) || delta <= 0) return undefined;
  const days = Math.floor(delta / 86_400_000);
  const hours = Math.floor((delta % 86_400_000) / 3_600_000);
  const minutes = Math.floor((delta % 3_600_000) / 60_000);
  const time =
    days > 0
      ? `${days}天${hours}小时`
      : hours > 0
        ? `${hours}小时${minutes}分`
        : `${minutes}分`;
  return `${time}后重置`;
}
