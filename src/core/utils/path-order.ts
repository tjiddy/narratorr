/**
 * Total, cross-platform-stable ordering over filesystem paths (#1891). Scan
 * dispositions (`duplicateFirstPath`, `isDuplicate` in the library scan) are
 * order-dependent under the non-transitive title predicate, so identical trees MUST
 * order identically regardless of `readdir` order, separator style, or folded-key
 * collisions. `discoverBooks` sorts its results with this before returning.
 *
 * PRIMARY key = a POSIX-folded path (separators → `/`, the repo's existing fold, e.g.
 * `findPathOwners`) so a Windows dev box and the POSIX Docker runtime order identically.
 * Folding is many-to-one over legal POSIX names (a folder named `a\b` folds like the
 * nested pair `a/b`), so a raw code-unit TIE-BREAK restores totality — the only zero
 * result is exact raw-path equality. `localeCompare` is NOT used (it can return 0 for
 * distinct collation-equivalent strings, defeating the guarantee).
 */
export function comparePosixPath(a: string, b: string): number {
  const ka = a.split('\\').join('/');
  const kb = b.split('\\').join('/');
  if (ka !== kb) return ka < kb ? -1 : 1;
  if (a !== b) return a < b ? -1 : 1;
  return 0;
}
