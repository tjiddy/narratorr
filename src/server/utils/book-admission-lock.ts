// Process-local locking is sufficient because Narratorr runs as one Node process.

/**
 * Serializes every mutation of one book's folder or identity — or, through
 * {@link withBookAdmissionLocks}, of one sorted SET of books.
 * Non-reentrant: holders must call unlocked primitives or deadlock.
 *
 * **The lock order is admission (book id) → claim key (path) → file key (sidecar / audio file),
 * outermost to innermost.** The claim-key tier is `withFreshClaimLock` / `claimLockKey`
 * (`./claim-lock.ts`); the file tier is `withPathWriteLock` (`./path-write-lock.ts`).
 * A holder of either path-domain lock must NEVER acquire this one — that inversion is the
 * deadlock, because the two domains key on different things and neither can see the other.
 *
 * Acquire at an operation's entry point, never inside a shared write primitive: `BookService.update`
 * (including its `{ tx }` arm), `BookService.fixMatch`'s inner transaction, `transitionBookStatus`,
 * `bookService.delete`, `findOrCreateNarrator` and `replaceFileAtomically` are reached from inside
 * held spans everywhere and would deadlock the first locked caller. A mutator reachable from both a
 * locked and an unlocked caller exposes an already-locked inner method instead of nesting —
 * `grabWithinAdmissionLock` (`../services/download-orchestrator.ts`) is the reference shape.
 *
 * Whatever row, path, library root or naming options the operation's later filesystem and DB work
 * derives from must be read, or revalidated, INSIDE the section. A mutator that wraps only its
 * mutating span can wake behind a rename or delete and write to a dead path.
 */
const bookAdmissionLocks = new Map<number, Promise<unknown>>();

export async function withBookAdmissionLock<T>(bookId: number, fn: () => Promise<T>): Promise<T> {
  const prev = bookAdmissionLocks.get(bookId) ?? Promise.resolve();
  // Run after the predecessor settles so a failing section never poisons the next caller.
  const run = prev.then(() => fn(), () => fn());
  const tail = run.then(() => undefined, () => undefined);
  bookAdmissionLocks.set(bookId, tail);
  void tail.then(() => {
    if (bookAdmissionLocks.get(bookId) === tail) bookAdmissionLocks.delete(bookId);
  });
  return run;
}

/**
 * Hold several books at once through ONE canonical acquisition, so two callers with mirrored id
 * sets can never deadlock. Mirrors `withPathWriteLocks` (`./path-write-lock.ts`).
 *
 * Three properties are load-bearing:
 *
 * - **Deadlock-freedom comes from canonicality, not from arithmetic.** Any deterministic total
 *   order makes mirrored callers acquire in the same sequence, so no cycle can form.
 * - **The order is numeric ascending, and that is a contract.** `[2, 10].sort()` yields `[10, 2]` —
 *   deterministic, therefore still deadlock-free, but not id order. The acquisition sequence is
 *   what a deadlock post-mortem reads, so the comparator is explicit.
 * - **A single acquisition is the one-element case of the same order,** so `withBookAdmissionLock(x)`
 *   and a batch containing `x` participate in one total order and cannot form a cycle.
 *
 * Acquisition is recursive, so a batch blocked on a mid-set key already HOLDS every lower-sorted key
 * in its set, and a second batch sharing one of those waits even though the key it needs is free.
 * That head-of-line blocking is inherent to the sorted-nesting shape and is accepted. Note what
 * bounds it: the blocked prefix is held for as long as the CONTENDING holder runs, and that holder
 * may be a merge, which #2369 accepted holding one book for minutes. No timeout, abandonment or
 * lock-stealing papers over it — a blocked batch is waiting, not leaking.
 */
export async function withBookAdmissionLocks<T>(bookIds: readonly number[], fn: () => Promise<T>): Promise<T> {
  // Dedupe before nesting: the lock is not re-entrant, so a repeated id would await a slot only the
  // outer level can settle.
  const ordered = [...new Set(bookIds)].sort((a, b) => a - b);
  const acquire = async (index: number): Promise<T> =>
    index === ordered.length ? fn() : withBookAdmissionLock(ordered[index]!, () => acquire(index + 1));
  return acquire(0);
}

/**
 * Test-only: drop every chain. Module-level state survives between cases, and once nearly every
 * mutator acquires, one test that leaves a section running queues the next test's mutator behind
 * it forever. Resetting is correct isolation — each case starts with no book held.
 */
export function resetBookAdmissionLocks(): void {
  bookAdmissionLocks.clear();
}

/**
 * Test-only: proves the key is evicted rather than leaked. A follow-up acquisition completing is
 * not the same evidence — a settled promise left in the map still lets the next caller through.
 * Mirrors `hasPendingPathWrite` (`./path-write-lock.ts`).
 */
export function hasPendingBookAdmission(bookId: number): boolean {
  return bookAdmissionLocks.has(bookId);
}
