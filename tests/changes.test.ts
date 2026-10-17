import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../server/app.js';
import { unknownPressure } from '../server/memory-pressure.js';

test(
  'live workspace invalidations are coalesced, payload-free, human-only and close cleanly with a connected reader',
  { timeout: 10000 },
  async () => {
    const state = await createApp({
      filename: ':memory:',
      port: 0,
      test: true,
      memoryPressureReader: unknownPressure,
    });
    const origin = await state.app.listen({ host: '127.0.0.1', port: 0 });
    try {
      for (const headers of [
        { authorization: 'Bearer native-companion' },
        { 'x-forge-workspace': 'demo' },
      ] as Record<string, string>[]) {
        const denied = await fetch(origin + '/api/changes', { headers });
        assert.equal(denied.status, headers.authorization ? 403 : 409);
        await denied.body?.cancel();
      }
      const response = await fetch(origin + '/api/changes', { signal: AbortSignal.timeout(8000) });
      assert.equal(response.status, 200);
      assert(response.headers.get('content-type')?.startsWith('text/event-stream'));
      assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
      const reader = response.body!.getReader();
      let text = new TextDecoder().decode((await reader.read()).value);
      assert(text.includes('connected'));
      state.local.transaction(() => {
        for (let i = 0; i < 20; i++)
          state.local.put('config', `private-fixture-${i}`, {
            secret: 'do-not-stream-context-or-credentials',
          });
      });
      while (!text.includes('workspace-change'))
        text += new TextDecoder().decode((await reader.read()).value);
      assert.equal(text.match(/event: workspace-change/g)?.length, 1);
      assert(
        !text.includes('private-fixture') &&
          !text.includes('do-not-stream') &&
          !text.includes('config'),
      );
      const closing = state.app.close();
      while (!(await reader.read()).done) {
        /* only bounded transport keepalives remain */
      }
      await closing;
    } finally {
      await state.app.close();
    }
  },
);
