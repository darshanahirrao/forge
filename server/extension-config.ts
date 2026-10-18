import { isAbsolute } from 'node:path';
import { z } from 'zod';

const modulePaths = z
  .array(
    z
      .string()
      .min(1)
      .max(2000)
      .refine((value) => isAbsolute(value) && !/[\x00-\x1f\x7f]/.test(value)),
  )
  .max(16);
/** Parsing does not execute, resolve or inspect any extension. Safe for service review. */
export function extensionPaths(value?: string): string[] {
  if (!value) return [];
  return modulePaths.parse(JSON.parse(z.string().max(32768).parse(value)));
}
