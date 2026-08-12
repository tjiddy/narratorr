/**
 * Stable total order for paths whose scan disposition is order-dependent. Fold separators
 * for Windows/POSIX parity, then compare raw code units to break folded-key collisions.
 * Do not use `localeCompare`: distinct collation-equivalent strings may compare equal.
 */
export function comparePosixPath(a: string, b: string): number {
  const ka = a.split('\\').join('/');
  const kb = b.split('\\').join('/');
  if (ka !== kb) return ka < kb ? -1 : 1;
  if (a !== b) return a < b ? -1 : 1;
  return 0;
}
