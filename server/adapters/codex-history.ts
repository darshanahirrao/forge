import { createHash } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import { z } from 'zod';
import type { Account } from '../../shared/types.js';
import type { NativeChatHistory } from '../../shared/native-continuations.js';
import { assert } from '../errors.js';
import { resolveCredential } from '../credentials.js';
import { acquireProfileLease } from './profile-lease.js';
import { nativeEnvironment, readCodexAccount } from './accounts.js';
import { findBinary } from './discovery.js';
import { NativeRpc } from './rpc.js';
import type { RpcFactory } from './codex-driver.js';

const identifier = z.string().min(1).max(200);
const metadata = z.object({
  thread: z.object({
    id: identifier,
    ephemeral: z.literal(false),
    cwd: z.string().min(1).max(2000),
    modelProvider: z.string().min(1).max(100),
    cliVersion: z.string().min(1).max(80),
    status: z.object({ type: z.enum(['notLoaded', 'idle']) }),
  }),
});
const page = z.object({
  data: z
    .array(
      z
        .object({
          id: identifier,
          status: z.enum(['completed', 'failed', 'interrupted', 'inProgress']),
          itemsView: z.literal('full'),
          items: z.array(z.unknown()).max(5000),
        })
        .passthrough(),
    )
    .max(25),
  nextCursor: z.string().max(2000).nullable(),
});

/** Hash complete bounded public native turns. No transcript text enters canonical state or prompts. */
export async function readCodexHistory(
  rpc: NativeRpc,
  threadId: string,
): Promise<NativeChatHistory> {
  const deadline = Date.now() + 20000;
  async function request(method: string, params: unknown) {
    const remaining = deadline - Date.now();
    assert(
      remaining > 0,
      409,
      'The native history read exceeded its finite review deadline. No partial history was substituted.',
    );
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        rpc.request(method, params),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(
            () => reject(new Error('Native history read deadline exceeded.')),
            remaining,
          );
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }
  const source = metadata.parse(
    await request('thread/read', { threadId, includeTurns: false }),
  ).thread;
  assert(source.id === threadId, 409, 'The native history response changed its source identity.');
  const cwd = await realpath(source.cwd);
  const hash = createHash('sha256').update('forge.codex-history/1\0');
  const cursors = new Set<string>(),
    turns = new Set<string>();
  let cursor: string | undefined,
    bytes = 0,
    items = 0,
    lastTurnId = '',
    lastStatus = '';
  for (let index = 0; index < 40; index++) {
    const result = page.parse(
      await request('thread/turns/list', {
        threadId,
        limit: 25,
        sortDirection: 'asc',
        itemsView: 'full',
        ...(cursor ? { cursor } : {}),
      }),
    );
    for (const turn of result.data) {
      assert(
        !turns.has(turn.id) && turn.status !== 'inProgress',
        409,
        'The native history is changing or contains an unfinished turn. Settle it in the native client before reviewing it.',
      );
      turns.add(turn.id);
      items += turn.items.length;
      const serialized = JSON.stringify(turn);
      bytes += Buffer.byteLength(serialized);
      assert(
        bytes <= 8 * 1024 * 1024 && items <= 5000,
        409,
        'This native history exceeds the bounded continuation review. Continue through the native client; no summary was substituted.',
      );
      hash.update(serialized).update('\0');
      lastTurnId = turn.id;
      lastStatus = turn.status;
    }
    if (result.nextCursor === null) {
      assert(
        turns.size > 0 && lastStatus === 'completed',
        409,
        'Continue a native chat after its latest turn completes. Review failed, interrupted or empty histories in the native client first.',
      );
      return {
        threadId,
        cwd,
        modelProvider: source.modelProvider,
        nativeVersion: source.cliVersion,
        lastTurnId,
        turns: turns.size,
        items,
        digest: hash.digest('hex'),
      };
    }
    assert(
      result.data.length > 0 && !cursors.has(result.nextCursor),
      409,
      'Native history pagination changed. Refresh the review before continuing.',
    );
    cursors.add(result.nextCursor);
    cursor = result.nextCursor;
  }
  assert(
    false,
    409,
    'This native history exceeds 1,000 turns. Continue in the native client; no partial history was substituted.',
  );
}

export type NativeChatReader = (
  account: Account,
  threadId: string,
) => Promise<{ history: NativeChatHistory; account: Account }>;
export function codexChatReader(
  factory: RpcFactory = (options) => new NativeRpc(options),
  selectedBinary?: string,
): NativeChatReader {
  return async (account, threadId) => {
    const binary = selectedBinary ?? (await findBinary('codex'));
    assert(binary, 409, 'Install Codex before reviewing its stored chat.');
    const material = await resolveCredential(account);
    let release: (() => void) | undefined,
      rpc: NativeRpc | undefined,
      timer: NodeJS.Timeout | undefined;
    try {
      release = await acquireProfileLease(account.nativeHome);
      rpc = factory({ binary, env: nativeEnvironment(account, material), timeoutMs: 5000 });
      rpc.on('message', (message) => {
        if (message.id !== undefined) rpc!.refuse(message.id);
      });
      timer = setTimeout(() => {
        void rpc!.stop();
      }, 20000);
      await rpc.initialize(true);
      const checked = await readCodexAccount(rpc, account);
      return { history: await readCodexHistory(rpc, threadId), account: checked };
    } finally {
      clearTimeout(timer);
      try {
        await rpc?.stop();
      } finally {
        release?.();
        material?.dispose();
      }
    }
  };
}
