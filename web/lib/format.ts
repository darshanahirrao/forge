import type { Harness } from '../../shared/types';
export const names: Record<Harness, string> = {
  codex: 'Codex',
  claude: 'Claude Code',
  opencode: 'OpenCode',
  hermes: 'Hermes',
  openclaw: 'OpenClaw',
};
export const statusNames: Record<string, string> = {
  ready: 'Ready',
  running: 'Running',
  waiting: 'Needs a decision',
  completed: 'Turn complete',
  failed: 'Needs review',
  interrupted: 'Interrupted',
};
export const currency = (value: number) =>
  new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 2,
  }).format(value);
export const compact = (value: number) =>
  new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 }).format(value);
export const gb = (value: number) => `${(value / 1024 ** 3).toFixed(1)} GB`;
export function age(value: string | null) {
  if (!value) return 'Not checked';
  const seconds = Math.max(0, (Date.now() - Date.parse(value)) / 1000);
  return seconds < 60
    ? 'Just now'
    : seconds < 3600
      ? `${Math.floor(seconds / 60)} min ago`
      : seconds < 86400
        ? `${Math.floor(seconds / 3600)} hr ago`
        : new Date(value).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}
