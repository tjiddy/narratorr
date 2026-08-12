/** Browser-side POSIX normalization only; the API rejects backslash paths. */
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

/** Segment comparison includes the root itself and prevents `/lib` from matching `/lib-old`. */
export function isPathInsideLibrary(scanPath: string, libraryPath: string): boolean {
  if (!scanPath?.trim() || !libraryPath?.trim()) return false;

  const rootSegments = normalizeSegments(libraryPath);
  const scanSegments = normalizeSegments(scanPath);

  if (scanSegments.length < rootSegments.length) return false;

  for (let i = 0; i < rootSegments.length; i++) {
    if (rootSegments[i] !== scanSegments[i]) return false;
  }

  // Block the root itself because scanning it would rediscover managed books.
  return true;
}

/** Returns a relative path only for strict descendants, rejecting traversal and prefix collisions. */
export function makeRelativePath(absolutePath: string, libraryPath: string): string | undefined {
  if (!absolutePath?.trim() || !libraryPath?.trim()) return undefined;

  const rootSegments = normalizeSegments(libraryPath);
  const pathSegments = normalizeSegments(absolutePath);

  if (pathSegments.length <= rootSegments.length) return undefined;

  for (let i = 0; i < rootSegments.length; i++) {
    if (rootSegments[i] !== pathSegments[i]) return undefined;
  }

  return pathSegments.slice(rootSegments.length).join('/');
}
