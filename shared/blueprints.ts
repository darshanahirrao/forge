import type { Account, MemorySource, NativeSource, Settings } from './types.js';

/** Shareable setup describes roles, never native credentials or saved execution authority. */
export interface BlueprintDefinition {
  format: 'forge.workspace-blueprint';
  version: 1;
  name?: string;
  harnesses: string[];
  accounts: { role: string; harness: string; billingMode: Account['billingMode'] }[];
  settings: { maxConcurrent: 1; memoryPressurePolicy?: Settings['memoryPressurePolicy'] };
  profiles: {
    role: string;
    name?: string;
    instructions?: string;
    memoryOwners: { owner: MemorySource['owner']; scope: MemorySource['scope']['kind'] }[];
    preferredCompanion: 'hermes' | 'openclaw' | null;
  }[];
  requirements: string[];
  workTemplates?: {
    role: string;
    title: string;
    goal: string;
    acceptance?: string;
    context?: string;
    accountRole: string;
    profileRole: string;
    projectRole: string;
  }[];
}
export interface BlueprintBindings {
  accounts: Record<string, string>;
  profiles: Record<string, string>;
  memories: Record<string, string>;
  companions: Record<string, string>;
  projects: Record<string, string>;
  applySettings: boolean;
}
export interface BlueprintPlan {
  id: string;
  digest: string;
  name: string;
  expiresAt: string;
  profiles: {
    role: string;
    name: string;
    instructions: string;
    memories: Pick<MemorySource, 'id' | 'label' | 'owner' | 'scope'>[];
    companion: Pick<NativeSource, 'id' | 'label' | 'kind'> | null;
  }[];
  work: {
    role: string;
    title: string;
    goal: string;
    acceptance: string;
    context: string;
    account: string;
    harness: string;
    directory: string;
    profileRole: string;
  }[];
  settings: { before: Settings; after: Settings } | null;
  warnings: string[];
}
export interface BlueprintReceipt {
  id: string;
  digest: string;
  name: string;
  createdAt: string;
  rolledBackAt: string | null;
  profiles: Record<string, string>;
  work: Record<string, string>;
  settings: { before: Settings; after: Settings } | null;
}
