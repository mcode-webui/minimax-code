// Which phrase the activity indicator shows, and when it starts.
//
// Carved out of `components/transcript/ActivityIndicator.tsx` by Phase 4b: the derivation moves to the
// layer that already owns the concept instead of riding along in the
// component that renders it. What moves is
// **7 declarations**, 4 functions, 3 types and constants they close over.
//
// The text below is the declaration as it stood in the source module — no
// behaviour change.

export interface ThinkingPhraseSet {
  basic: readonly string[];
  specific: readonly string[];
  motion: readonly string[];
}

interface WeightedPhraseBucket {
  key: keyof ThinkingPhraseSet;
  weight: number;
  phrases: readonly string[];
}

const DEFAULT_WEIGHTS: readonly { key: keyof ThinkingPhraseSet; weight: number }[] = [
  { key: "basic", weight: 0.75 },
  { key: "specific", weight: 0.15 },
  { key: "motion", weight: 0.1 },
];

export function bucketPhrases(phrases: ThinkingPhraseSet): WeightedPhraseBucket[] {
  return DEFAULT_WEIGHTS.map((entry) => ({
    key: entry.key,
    weight: entry.weight,
    phrases: phrases[entry.key] ?? [],
  })).filter((bucket) => bucket.phrases.length > 0);
}

export function pickWeightedPhrase(
  buckets: readonly WeightedPhraseBucket[],
  previous: string | null,
  random: () => number = Math.random,
): string | null {
  if (buckets.length === 0) return null;
  const totalWeight = buckets.reduce((sum, bucket) => sum + bucket.weight, 0);
  if (totalWeight <= 0) return null;
  let threshold = random() * totalWeight;
  let chosen: WeightedPhraseBucket | null = null;
  for (const bucket of buckets) {
    threshold -= bucket.weight;
    if (threshold <= 0) {
      chosen = bucket;
      break;
    }
  }
  if (!chosen) {
    chosen = buckets[buckets.length - 1] ?? null;
  }
  if (!chosen) return null;
  const pool = chosen.phrases;
  if (pool.length === 0) return null;
  let candidates = pool;
  if (previous && pool.length > 1) {
    const filtered = pool.filter((entry) => entry !== previous);
    if (filtered.length > 0) candidates = filtered;
  }
  return candidates[Math.floor(random() * candidates.length)] ?? null;
}

export function computeThinkingPhraseStartDelay(
  startMinMs: number,
  startMaxMs: number,
  random: () => number = Math.random,
): number {
  return startMinMs + random() * Math.max(0, startMaxMs - startMinMs);
}

export function shouldPlayActivityIndicator(prefersReducedMotion: boolean): boolean {
  return !prefersReducedMotion;
}
