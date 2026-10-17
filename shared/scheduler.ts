export interface SchedulerObservation {
  contract: 'hermes-native-ticker/1';
  provider: string | null;
  loopAgeSeconds: number | null;
  successAgeSeconds: number | null;
  cadenceSeconds: number | null;
  observedAt: string;
}

/** Age saved native evidence without turning a saved observation into a live health claim. */
export function schedulerEvidence(observation?: SchedulerObservation, at = Date.now()) {
  const unknown = { state: 'unknown', label: 'Scheduler health unknown' };
  if (!observation || !observation.provider) return unknown;
  if (!['builtin', 'in-process', 'inprocess'].includes(observation.provider))
    return { state: 'external', label: 'External scheduler configured; health unknown' };
  const elapsed = (at - Date.parse(observation.observedAt)) / 1000;
  if (!Number.isFinite(elapsed) || elapsed < -2 || !observation.cadenceSeconds) return unknown;
  const threshold = observation.cadenceSeconds * 3 + 20;
  const loop = observation.loopAgeSeconds,
    success = observation.successAgeSeconds;
  if (loop === null) return unknown;
  if (loop + Math.max(0, elapsed) > threshold)
    return { state: 'loop-stale', label: 'Native ticker observation is stale' };
  if (success === null) return unknown;
  if (success + Math.max(0, elapsed) > threshold)
    return { state: 'success-stale', label: 'Recent ticker loop; successful tick is stale' };
  return { state: 'recent', label: 'Recent successful native tick observed' };
}
