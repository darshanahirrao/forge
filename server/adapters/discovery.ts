import { access } from 'node:fs/promises';
import { constants } from 'node:fs';
import { delimiter, join } from 'node:path';
import type { Connection } from '../../shared/types.js';

export async function findBinary(name: string): Promise<string | null> {
  for (const directory of (process.env.PATH ?? '').split(delimiter).filter(Boolean)) {
    const filename = join(directory, process.platform === 'win32' ? `${name}.exe` : name);
    try {
      await access(filename, constants.X_OK);
      return filename;
    } catch {
      /* Continue through PATH. */
    }
  }
  return null;
}
const definitions: Omit<Connection, 'installed'>[] = [
  {
    id: 'codex',
    name: 'Codex',
    kind: 'harness',
    capabilities: [
      'Native account check',
      'Native allowance',
      'Managed turns',
      'Command approvals',
      'Token usage',
    ],
    description:
      'Native app-server execution and permissions. Each managed task gets its own connection.',
    documentation: 'https://developers.openai.com/codex/app-server',
  },
  {
    id: 'claude',
    name: 'Claude Code',
    kind: 'harness',
    capabilities: [
      'Native account check',
      'API-managed turns',
      'Native permission requests',
      'Token and cost estimates',
    ],
    description:
      'Native account slots plus Claude Agent SDK execution with explicit API authentication. Subscription sessions remain in the native client.',
    documentation: 'https://code.claude.com/docs/en/authentication',
  },
  {
    id: 'hermes',
    name: 'Hermes',
    kind: 'runtime',
    capabilities: [
      'Native ACP turns',
      'Native edit reviews',
      'Native memory and skills',
      'Health check',
      'Capability discovery',
    ],
    description:
      'Launch an owned native ACP worker from an explicit Hermes home, or observe an existing local API server. Provider identity and allowance are not verified.',
    documentation: 'https://hermes-agent.nousresearch.com/docs/user-guide/features/acp',
  },
  {
    id: 'opencode',
    name: 'OpenCode',
    kind: 'harness',
    capabilities: [
      'Native v2 profile',
      'Managed turns',
      'Native permission queue',
      'Token and cost estimates',
    ],
    description:
      'Owned native v2 server and official client. Explicit profile roots keep native state separate. Provider allowance is not verified.',
    documentation: 'https://opencode.ai/v2/docs/build/client/',
  },
  {
    id: 'openclaw',
    name: 'OpenClaw',
    kind: 'runtime',
    capabilities: [
      'Native Gateway turns',
      'Native command approvals',
      'Native memory and tools',
      'Token and cost estimates',
    ],
    description:
      'Owned foreground Gateway for a dedicated execution profile, using the official client. Existing companion channels and schedules retain their native owner.',
    documentation: 'https://docs.openclaw.ai/gateway/protocol',
  },
  {
    id: 'agent-deck',
    name: 'Agent Deck',
    kind: 'source',
    capabilities: ['Read-only session inventory'],
    description:
      'Reuse an existing session manager. Forge does not install it or take ownership of its sessions.',
    documentation: 'https://github.com/asheshgoplani/agent-deck',
  },
  {
    id: 'ccusage',
    name: 'ccusage',
    kind: 'source',
    capabilities: ['Claude usage', 'Estimated cost'],
    description: 'Read native daily JSON reports instead of rebuilding transcript parsers.',
    documentation: 'https://ccusage.com/guide/json-output',
  },
];
export async function discover(): Promise<Connection[]> {
  return Promise.all(
    definitions.map(async (c) => ({ ...c, installed: Boolean(await findBinary(c.id)) })),
  );
}
