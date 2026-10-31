// The two message actions that write: a thumbs vote and a copy.
//
// Carved out of `components/transcript/MessageActions.tsx` by Phase 4b: the derivation moves to the
// layer that already owns the concept instead of riding along in the
// component that renders it. What moves is
// **4 declarations**, 3 functions, 1 type and constant they close over.
//
// The text below is the declaration as it stood in the source module — no
// behaviour change.

export function toggleWebuiFeedback(
  value: "like" | "dislike" | undefined,
  next: "like" | "dislike",
): "like" | "dislike" {
  return value === next ? (next === "like" ? "dislike" : "like") : next;
}

export interface WebuiCopyDependencies {
  readonly clipboard?: { readonly writeText: (value: string) => Promise<void> };
  readonly fallback?: () => void;
}

export async function copyWebuiMessageText(
  value: string,
  dependencies: WebuiCopyDependencies,
): Promise<boolean> {
  try {
    if (dependencies.clipboard) await dependencies.clipboard.writeText(value);
    else if (dependencies.fallback) dependencies.fallback();
    else return false;
    return true;
  } catch {
    return false;
  }
}

export function scheduleWebuiCopiedReset(
  setCopied: (value: boolean) => void,
  schedule: (callback: () => void, delayMs: number) => unknown,
): void {
  schedule(() => setCopied(false), 1_200);
}
