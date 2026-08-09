import type { z } from 'zod';

// Format only the first issue as path: message. Top-level issues omit the empty path;
// callers preserve the full ZodError as cause.
export function formatZodError(error: z.ZodError): string {
  const issue = error.issues[0];
  const path = issue?.path.join('.') ?? '';
  const message = issue?.message ?? 'unknown';
  return path ? `${path}: ${message}` : message;
}
