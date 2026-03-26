/**
 * POSIX-safe path ancestor check for browser environments.
 * Does not use node:path — splits on '/' and compares segments.
 */
function normalizeSegments(p: string): string[] {
  return p.trim().split('/').filter(Boolean);
}

/**
 * Returns true if scanPath is strictly inside libraryPath (i.e., libraryPath
 * is an ancestor of scanPath, not equal to it).
 *
 * Uses segment-prefix comparison to avoid the startsWith() false-positive
 * (e.g., /lib vs /lib-old) — per CLAUDE.md security guidelines.
 */
export function isPathInsideLibrary(scanPath: string, libraryPath: string): boolean {
  if (!scanPath?.trim() || !libraryPath?.trim()) return false;

  const rootSegments = normalizeSegments(libraryPath);
  const scanSegments = normalizeSegments(scanPath);

  // Must have more segments to be strictly inside
  if (scanSegments.length <= rootSegments.length) return false;

  // All root segments must match the leading scan segments
  for (let i = 0; i < rootSegments.length; i++) {
    if (rootSegments[i] !== scanSegments[i]) return false;
  }

  return true;
}
