export function getErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  const str = String(error);
  return str || 'Unknown error';
}

// Undici wraps useful network diagnostics in Error.cause.
export function getErrorMessageWithCause(error: unknown): string {
  if (error instanceof Error) {
    const cause = error.cause as { message?: string; code?: string } | undefined;
    return cause?.message ?? cause?.code ?? error.message;
  }
  const str = String(error);
  return str || 'Unknown error';
}

// Drizzle/libSQL may nest SQLite diagnostics in cause.message. Test cause and
// top-level independently instead of choosing one.
export function isUniqueViolation(error: unknown, pattern: RegExp): boolean {
  if (!(error instanceof Error)) return false;
  const causeMsg = (error as Error & { cause?: { message?: string } }).cause?.message ?? '';
  if (pattern.test(causeMsg)) return true;
  return pattern.test(error.message ?? '');
}
