/** One OS sample. RSS includes shared pages; CPU uses the native ps scale. */
export interface ResourceGroup {
  id: string;
  kind: 'host' | 'managed' | 'native-app' | 'other';
  label: string;
  state: 'observed' | 'not-observed' | 'identity-changed' | 'ambiguous' | 'unavailable';
  rootPids: number[];
  rootCount: number;
  processCount: number;
  rss: number | null;
  cpuPercent: number | null;
  workId?: string;
  runId?: string;
  harness?: string;
}

export interface ResourceObservation {
  contract: 'forge.resource-observation/1';
  sampledAt: string;
  coverage: 'observed' | 'unavailable';
  processCount: number;
  rss: number | null;
  cpuPercent: number | null;
  unresolvedWorkers: number;
  groups: ResourceGroup[];
}
