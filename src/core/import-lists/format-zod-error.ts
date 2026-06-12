import type { z } from 'zod';

/**
 * Format the first issue of a ZodError into a `<path>: <message>` string so
 * nested import-list response failures read e.g. `libraries.0.name: Invalid input…`
 * or `results.books: Expected array…`. Shared across the import-list providers
 * (ABS/NYT/Hardcover) and the ABS library route to keep their validation
 * messages grep-consistent. Top-level failures have an empty `path` array —
 * guard so we never emit a leading `": "` artifact. Only the first issue is
 * formatted (matching the providers' single-message convention); the full
 * `ZodError` is still passed as the thrown error's `cause`.
 */
export function formatZodError(error: z.ZodError): string {
  const issue = error.issues[0];
  const path = issue?.path.join('.') ?? '';
  const message = issue?.message ?? 'unknown';
  return path ? `${path}: ${message}` : message;
}
