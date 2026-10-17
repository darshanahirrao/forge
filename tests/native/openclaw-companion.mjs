// Test-only native OpenClaw 2026.10.4 MCP runtime. Production Forge imports no private native module.
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';

let raw = '';
for await (const chunk of process.stdin) raw += chunk;
const fixture = JSON.parse(raw);
const { createSessionMcpRuntime } = await import(
  pathToFileURL(join(fixture.packageRoot, 'dist/agents/agent-bundle-mcp-runtime.js')).href
);
const runtime = createSessionMcpRuntime({
  sessionId: 'forge-isolated-native-companion',
  workspaceDir: fixture.project,
  agentDir: fixture.home,
  cfg: {
    plugins: { enabled: false },
    mcp: {
      servers: {
        forge: {
          url: fixture.endpoint,
          transport: 'streamable-http',
          headers: { Authorization: `Bearer ${fixture.token}` },
          connectionTimeoutMs: 10000,
          requestTimeoutMs: 15000,
        },
      },
    },
  },
});
async function call(name, input) {
  const result = await runtime.callTool('forge', name, input);
  assert(!result.isError, 'The native OpenClaw MCP call failed.');
  return (
    result.structuredContent ??
    JSON.parse(result.content.find((block) => block.type === 'text').text)
  );
}
try {
  const catalog = await runtime.getCatalog();
  assert.equal(catalog.tools.length, fixture.expectedTools ?? 5);
  const work = (await call('forge_work', { workId: fixture.workId })).work;
  assert.equal(work.profileId, fixture.profileId);
  const context = await call('forge_context', { workId: work.id });
  assert(JSON.stringify(context).includes('native-selected-copper'));
  assert(!JSON.stringify(context).includes('native-excluded-violet'));
  if (fixture.handoff) {
    const ready = await call('forge_companion_ready', fixture.handoff);
    assert.equal(ready.state, 'ready');
    console.log(
      JSON.stringify({
        native: 'OpenClaw MCP runtime',
        ready: true,
        tools: catalog.tools.length,
        paidModelCalls: 0,
      }),
    );
  } else {
    const input = {
      requestId: 'native-openclaw-note',
      workId: work.id,
      expectedRevision: work.revision,
      note: 'Native OpenClaw MCP continued the same Forge work after Hermes.',
    };
    const note = await call('forge_checkpoint', input);
    assert.equal((await call('forge_checkpoint', input)).id, note.id);
    console.log(
      JSON.stringify({
        native: 'OpenClaw MCP runtime',
        tools: catalog.tools.length,
        sameWorkAndProfile: true,
        selectedMemory: true,
        idempotentCheckpoint: true,
        paidModelCalls: 0,
      }),
    );
  }
} finally {
  await runtime.dispose();
  await runtime.joinCleanup();
}
