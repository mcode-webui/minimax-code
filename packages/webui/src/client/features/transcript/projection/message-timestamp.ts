// How a message's timestamp reads in the transcript.
//
// Carved out of `components/transcript/MessageActions.tsx` by Phase 4b: the derivation moves to the
// layer that already owns the concept instead of riding along in the
// component that renders it. What moves is
// **1 declaration**, 1 function.
//
// The text below is the declaration as it stood in the source module — no
// behaviour change.

/** Timestamp format for the action row: `9月22日, 22:37`. */
export function formatWebuiMessageTimestamp(value?: number): string | undefined {
  if (value === undefined || !Number.isFinite(value)) return undefined;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return undefined;
  const pad = (input: number) => String(input).padStart(2, "0");
  return `${date.getMonth() + 1}月${date.getDate()}日, ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
