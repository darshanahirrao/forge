export class ForgeError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
export function assert(condition: unknown, status: number, message: string): asserts condition {
  if (!condition) throw new ForgeError(status, message);
}
export function safeMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : 'The operation could not complete.';
  return message
    .replace(/\x1b\[[0-9;]*m/g, '')
    .replace(/Bearer\s+\S+/gi, 'Bearer [redacted]')
    .replace(/sk-[A-Za-z0-9_-]{12,}/g, '[redacted]')
    .slice(0, 600);
}
