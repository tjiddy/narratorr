/**
 * In-place tag writes changed the safety model. The old temp-file + atomic rename made an
 * interleaved write last-writer-wins on a *whole* file; two mutagen processes patching one header
 * can interleave into a file neither caller asked for. Six production surfaces reach the same file
 * (books, books-series, books-fix-match, bulk-operation, merge-post-tag, import-steps) and none of
 * them holds a lock, so the tagging service takes this one on every write with no bypass.
 *
 * The sidecar writer joins on the same terms: its sequence is read → compare → back up → record →
 * replace, so an unserialized peer can land between the read and the backup and make
 * `metadata.opf.bak` capture bytes that were never the ones replaced (#2297).
 *
 * Keyed on the absolute file path, not the book id: a pointer import means two books can
 * address one file, and the unit of mutation is the file. Audio paths and `metadata.opf` paths
 * cannot collide as keys, so one map serves both callers.
 *
 * Serialize, don't coalesce. `singleFlightReplace` (book-admission.ts) is the prior art for the
 * keyed-map mechanics, including its evict-only-if-you-still-own-the-slot guard, but its semantics
 * are wrong here: two retags of one file can carry different excludeFields/mode, so both must run
 * in turn rather than share one result.
 *
 * Readers are deliberately not locked — `readExistingTags` already fails soft to `{}` on a parse
 * error, so a preview taken mid-write degrades to an empty diff, and the confirm path takes the lock.
 *
 * NOT re-entrant: acquiring a key already held awaits a slot only the outer holder can settle.
 * Acquire once, at a writer's entry point.
 *
 * Narratorr is single-process, so an in-memory chain is sufficient — the same rationale that keeps
 * the connector refresh queue in-memory (SECURITY.md, #769/#877/#885).
 */
const chains = new Map<string, Promise<void>>();

export async function withPathWriteLock<T>(filePath: string, op: () => Promise<T>): Promise<T> {
  const previous = chains.get(filePath) ?? Promise.resolve();
  // Run on either predecessor outcome: a failed write must not wedge the key for the next caller.
  const run = previous.then(op, op);
  const slot = run.then(() => undefined, () => undefined);
  chains.set(filePath, slot);
  void slot.then(() => {
    if (chains.get(filePath) === slot) chains.delete(filePath);
  });
  return run;
}

/** Test-only: proves the key is released rather than leaked. */
export function hasPendingPathWrite(filePath: string): boolean {
  return chains.has(filePath);
}
