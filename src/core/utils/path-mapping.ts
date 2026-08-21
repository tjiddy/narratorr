export interface PathMapping {
  remotePath: string;
  localPath: string;
}

function normalize(p: string): string {
  return p.replace(/\\/g, '/').replace(/\/$/, '') + '/';
}

/** Applies the longest matching remote prefix; leaves unmatched paths unchanged. */
export function applyPathMapping(fullPath: string, mappings: PathMapping[]): string {
  if (mappings.length === 0) return fullPath;

  const normalizedPath = fullPath.replace(/\\/g, '/');

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

  const remainder = normalizedPath.slice(normalizedRemote.length - 1); // keep the leading /
  const mapped = normalizedLocal.slice(0, -1) + remainder; // remove the local trailing slash before adding the remainder

  // A root local ('/' or 'C:\') is nothing but its separator, so a whole-path match strips it to
  // '' or a drive-relative 'C:' — both resolve to the process CWD downstream (#2551). Restore the
  // root spelling; non-root locals keep the exact pre-#2551 output.
  if (mapped === '' || /^[A-Za-z]:$/.test(mapped)) return normalizedLocal;

  return mapped;
}
