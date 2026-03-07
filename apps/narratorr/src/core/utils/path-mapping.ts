/**
 * Cross-platform path mapping utilities.
 * Translates remote (container/Docker) paths to local host paths.
 */

export interface PathMapping {
  remotePath: string;
  localPath: string;
}

/** Normalize separators to forward slashes and ensure trailing slash. */
function normalize(p: string): string {
  return p.replace(/\\/g, '/').replace(/\/$/, '') + '/';
}

/**
 * Apply a set of path mappings to a full file path.
 * Selects the longest matching remote prefix (most specific match).
 * Returns the path unchanged if no mapping matches.
 */
export function applyPathMapping(fullPath: string, mappings: PathMapping[]): string {
  if (mappings.length === 0) return fullPath;

  const normalizedPath = fullPath.replace(/\\/g, '/');

  // Find the longest matching remote prefix
  let bestMatch: PathMapping | null = null;
  let bestLength = 0;

  for (const mapping of mappings) {
    const normalizedRemote = normalize(mapping.remotePath);
    if (normalizedPath.startsWith(normalizedRemote) || (normalizedPath + '/').startsWith(normalizedRemote)) {
      if (normalizedRemote.length > bestLength) {
        bestMatch = mapping;
        bestLength = normalizedRemote.length;
      }
    }
  }

  if (!bestMatch) return fullPath;

  const normalizedRemote = normalize(bestMatch.remotePath);
  const normalizedLocal = normalize(bestMatch.localPath);

  // Replace the remote prefix with the local prefix
  const remainder = normalizedPath.slice(normalizedRemote.length - 1); // keep the leading /
  const mapped = normalizedLocal.slice(0, -1) + remainder; // remove trailing / from local, add remainder

  return mapped;
}
