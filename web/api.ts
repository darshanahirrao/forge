import type { WorkspaceMode } from '../shared/types';

export async function request<T>(
  path: string,
  mode: WorkspaceMode,
  csrf = '',
  method = 'GET',
  body?: unknown,
): Promise<T> {
  const response = await fetch(`/api${path}`, {
    method,
    headers: {
      'X-Forge-Workspace': mode,
      ...(method !== 'GET' ? { 'Content-Type': 'application/json', 'X-Forge-Csrf': csrf } : {}),
    },
    body: method === 'GET' ? undefined : JSON.stringify(body ?? {}),
    credentials: 'same-origin',
  });
  const data = await response
    .json()
    .catch(() => ({ error: 'Forge returned an unreadable response. Reload the workspace.' }));
  if (!response.ok)
    throw new Error(data.error ?? `The operation returned HTTP ${response.status}.`);
  return data as T;
}
export async function download(path: string, filename: string, mode: WorkspaceMode) {
  const data = await request(path, mode);
  const url = URL.createObjectURL(
    new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }),
  );
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export type Mutate = <T = unknown>(path: string, method: string, body?: unknown) => Promise<T>;
