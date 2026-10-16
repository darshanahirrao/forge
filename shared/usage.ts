import type { Usage } from './types.js';

/** Aggregate imports cannot be added to native sessions when their coverage can overlap. */
export function usageSummary(usage: Usage[]) {
  const nativeHarnesses = new Set(
    usage.filter((u) => u.source !== 'ccusage' && u.source !== 'example').map((u) => u.harness),
  );
  const excludedAggregates = usage.filter(
    (u) => u.source === 'ccusage' && nativeHarnesses.has(u.harness),
  );
  const entries = usage.filter((u) => !excludedAggregates.includes(u));
  const estimated = entries.filter((u) => u.estimatedUsd !== null);
  return {
    entries,
    excludedAggregates,
    totalTokens: entries.reduce((sum, u) => sum + u.totalTokens, 0),
    estimatedUsd: estimated.length ? estimated.reduce((sum, u) => sum + u.estimatedUsd!, 0) : null,
    incomplete: entries.some((u) => u.estimatedUsd === null) || excludedAggregates.length > 0,
  };
}
