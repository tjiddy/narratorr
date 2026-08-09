// Only ENOENT/ENOTDIR prove absence; permission, stale-handle, I/O, and malformed errors must retain paths.
export const DEFINITIVE_ABSENCE_CODES: ReadonlySet<string> = new Set(['ENOENT', 'ENOTDIR']);

export function errnoCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}

// Only .code counts; an "ENOENT" message is inconclusive.
export function isDefinitiveAbsence(error: unknown): boolean {
  const code = errnoCode(error);
  return code !== undefined && DEFINITIVE_ABSENCE_CODES.has(code);
}
