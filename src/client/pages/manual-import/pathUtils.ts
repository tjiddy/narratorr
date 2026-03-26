/**
 * POSIX-safe path ancestor check for browser environments.
 * Does not use node:path — splits on '/' and resolves '..' and '.' segments.
 */
function normalizeSegments(p: string): string[] {
  const result: string[] = [];
  for (const seg of p.trim().split('/').filter(Boolean)) {
    if (seg === '..') {
      result.pop();
    } else if (seg !== '.') {
      result.push(seg);
    }
  }
  return result;
}

/**
 * Returns true if scanPath is inside libraryPath OR exactly equal to it,
 * after resolving '..' and '.' segments.
 *
 * Uses segment-prefix comparison to avoid the startsWith() false-positive
 * (e.g., /lib vs /lib-old) — per CLAUDE.md security guidelines.
 */
export function isPathInsideLibrary(scanPath: string, libraryPath: string): boolean {
  if (!scanPath?.trim() || !libraryPath?.trim()) return false;

  const rootSegments = normalizeSegments(libraryPath);
  const scanSegments = normalizeSegments(scanPath);

  // Must have same or more segments to be equal or inside
  if (scanSegments.length < rootSegments.length) return false;

  // All root segments must match the leading scan segments
  for (let i = 0; i < rootSegments.length; i++) {
    if (rootSegments[i] !== scanSegments[i]) return false;
  }

  // equal (scanSegments.length === rootSegments.length) counts as blocked —
  // scanning the library root itself would rediscover already-managed books
  return true;
}
