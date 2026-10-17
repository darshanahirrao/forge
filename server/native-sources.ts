import { stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { NativeInventory, NativeSource, NativeSourceKind } from '../shared/types.js';
import { assert, ForgeError } from './errors.js';
import { Store, id } from './store.js';
import { readNativeInventory, type InventoryOptions } from './adapters/inventory.js';

export interface NativeSourcesOptions extends InventoryOptions {
  homes?: { codex?: string; claude?: string; hermes?: string };
  reader?: typeof readNativeInventory;
  isManagedBusy?: () => boolean;
}
export class NativeSources {
  private reading = new Set<string>();
  get isReading() {
    return this.reading.size > 0;
  }
  constructor(
    private store: Store,
    private options: NativeSourcesOptions = {},
  ) {}
  list() {
    return this.store.all<NativeSource>('native_sources');
  }
  inventories() {
    return this.store.all<NativeInventory & { sourceId: string }>('native_inventories');
  }
  add(input: Pick<NativeSource, 'kind' | 'label' | 'home' | 'endpoint' | 'tokenEnv'>) {
    const duplicate = this.list().find(
      (s) =>
        s.kind === input.kind &&
        s.home === input.home &&
        s.endpoint === input.endpoint &&
        s.tokenEnv === input.tokenEnv,
    );
    if (duplicate) return duplicate;
    const source: NativeSource = {
      ...input,
      id: id(),
      state: 'configured',
      checkedAt: null,
      error: null,
      capabilities: [],
    };
    return this.store.put('native_sources', source.id, source);
  }
  async discover() {
    const homes = {
      codex: this.options.homes?.codex ?? process.env.CODEX_HOME ?? join(homedir(), '.codex'),
      claude:
        this.options.homes?.claude ?? process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude'),
      hermes: this.options.homes?.hermes ?? process.env.HERMES_HOME ?? join(homedir(), '.hermes'),
    };
    const candidates: { kind: NativeSourceKind; label: string; home: string; exists: string }[] = [
      { kind: 'codex', label: 'Codex native chats', home: homes.codex, exists: homes.codex },
      { kind: 'claude', label: 'Claude native chats', home: homes.claude, exists: homes.claude },
      {
        kind: 'codex-schedules',
        label: 'Codex desktop schedules',
        home: homes.codex,
        exists: join(homes.codex, 'automations'),
      },
      {
        kind: 'hermes-schedules',
        label: 'Hermes profile schedules',
        home: homes.hermes,
        exists: join(homes.hermes, 'cron', 'jobs.json'),
      },
    ];
    const found: NativeSource[] = [];
    for (const candidate of candidates) {
      if (
        await stat(candidate.exists)
          .then(() => true)
          .catch(() => false)
      )
        found.push(
          this.add({
            kind: candidate.kind,
            label: candidate.label,
            home: candidate.home,
            endpoint: '',
          }),
        );
    }
    return found;
  }
  async refresh(sourceId: string) {
    const source = this.store.get<NativeSource>('native_sources', sourceId);
    assert(source, 404, 'This native source was not found.');
    assert(
      !this.reading.size,
      409,
      'A native inventory read is in progress. Wait for it to finish.',
    );
    assert(
      !this.options.isManagedBusy?.(),
      409,
      'Refresh native activity after the current native worker or account check finishes to preserve laptop headroom.',
    );
    this.reading.add(sourceId);
    try {
      const result = await (this.options.reader ?? readNativeInventory)(source, this.options);
      this.store.transaction(() => {
        this.store.put('native_inventories', sourceId, { ...result.inventory, sourceId });
        this.store.put('native_sources', sourceId, {
          ...source,
          state: 'connected',
          checkedAt: result.inventory.checkedAt,
          error: null,
          capabilities: result.capabilities,
          observation: {
            sessions: result.inventory.sessions.length,
            schedules: result.inventory.schedules.length,
            moreAvailable: result.inventory.moreAvailable,
          },
        });
      });
      return result.inventory;
    } catch (error) {
      // Preserve the previous successful observation and its original timestamp on a failed refresh.
      // Native parser/child errors can contain excerpts or diagnostic secrets. Store only known messages.
      const safeError =
        error instanceof ForgeError
          ? error
          : new ForgeError(
              502,
              'The native metadata could not be read. Check its installation, source format and local access, then refresh.',
            );
      this.store.put('native_sources', sourceId, {
        ...source,
        state: 'error',
        error: safeError.message,
      });
      throw safeError;
    } finally {
      this.reading.delete(sourceId);
    }
  }
  remove(sourceId: string) {
    assert(
      !this.reading.has(sourceId),
      409,
      'Wait for this native read to finish before disconnecting.',
    );
    assert(this.store.get('native_sources', sourceId), 404, 'This native source was not found.');
    this.store.transaction(() => {
      this.store.remove('native_sources', sourceId);
      this.store.remove('native_inventories', sourceId);
    });
  }
}
