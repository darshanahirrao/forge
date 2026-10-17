import type { MemoryScope, MemorySource } from './types.js';

/** Explicit private snapshots contain selected text. They never carry execution authority. */
export interface MemoryPack {
  format: 'forge.private-memory-pack';
  version: 1;
  createdAt: string;
  profile: { id: string; name: string; instructions: string };
  entries: {
    key: string;
    label: string;
    scope: MemoryScope;
    content: string;
    sha256: string;
    provenance: {
      sourceId: string;
      owner: MemorySource['owner'];
      path: string;
      section: string[];
      fileSha256: string;
    };
  }[];
}
export interface MemoryPackPlan {
  id: string;
  digest: string;
  expiresAt: string;
  mode: 'native-copy' | 'import';
  profileId: string;
  profileName: string;
  profileRevision: number;
  instructions: 'keep' | 'replace';
  currentInstructions: string;
  pack: MemoryPack;
  directory: string;
  bindings: { key: string; scope: MemoryScope; path: string }[];
}
export interface MemoryPackReceipt {
  id: string;
  digest: string;
  packSha256: string;
  state: 'staging' | 'applied' | 'failed';
  profileId: string;
  directory: string;
  sourceIds: string[];
  createdAt: string;
  updatedAt: string;
  detail: string;
}
