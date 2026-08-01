/**
 * Errno classification for filesystem probes (#1955).
 *
 * A failed `access()` is not proof that a path is gone. Only a definitive
 * absence errno says the filesystem looked and found nothing; every other
 * failure — a search-permission wall on a re-mounting share (`EACCES`), a dead
 * NFS handle (`ESTALE`), an I/O fault (`EIO`), fd exhaustion (`EMFILE`) — means
 * the probe could not tell. Callers that persist an absence verdict must fail
 * toward retention, so an unrecognised, non-string, or absent `code` classifies
 * as *undetermined*, never as absence.
 *
 * Pure and dependency-free, and deliberately not scan-named: every reconciler
 * that probes a library path needs the same discriminator.
 */

/** The only errno codes that prove the path is really gone. */
export const DEFINITIVE_ABSENCE_CODES: ReadonlySet<string> = new Set(['ENOENT', 'ENOTDIR']);

/**
 * Read a Node errno `code` off an unknown caught value. Returns `undefined` for
 * non-objects and for a `code` that is present but not a string, so a numeric
 * `errno`-style field never leaks into a diagnostic code set.
 */
export function errnoCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}

/**
 * True only when the caught value carries a definitive-absence errno code. The
 * message is never the discriminator — a codeless `new Error('ENOENT')` is
 * undetermined, not absence.
 */
export function isDefinitiveAbsence(error: unknown): boolean {
  const code = errnoCode(error);
  return code !== undefined && DEFINITIVE_ABSENCE_CODES.has(code);
}
