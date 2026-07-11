// ============================================================================
// Per-book grab admission serialization + single-flight replace coalescing (#1857)
//
// Two process-local primitives shared by every book-scoped grab entry point.
// Process-local + best-effort is sufficient and migration-free because narratorr
// runs as a single Node process (the documented single-user self-hosted threat
// model — same precedent as the v1 keyed release mutex).
// ============================================================================

/**
 * Per-`bookId` admission mutex. Serializes the shared duplicate-check → client-add
 * → insert critical section so no two book-scoped admissions (internal grab, v1,
 * RSS, retrySearch, search-pipeline, and the confirmed-replace workflow) can
 * interleave for the same book. Same Map-of-tails mechanism as v1's
 * `withReleaseLock`, keyed on `bookId`.
 *
 * NON-REENTRANT: a second acquisition of the same key chains behind the still
 * unresolved outer tail, so a holder must NOT re-acquire it. The replace workflow
 * acquires the key once and calls the private unlocked `grabWithinAdmissionLock`
 * primitive rather than re-entering the public lock (else self-deadlock, F31).
 */
const bookAdmissionLocks = new Map<number, Promise<unknown>>();

export async function withBookAdmissionLock<T>(bookId: number, fn: () => Promise<T>): Promise<T> {
  const prev = bookAdmissionLocks.get(bookId) ?? Promise.resolve();
  // Run our section after the predecessor settles (resolve OR reject) so a
  // failing critical section never poisons the next caller.
  const run = prev.then(() => fn(), () => fn());
  const tail = run.then(() => undefined, () => undefined);
  bookAdmissionLocks.set(bookId, tail);
  void tail.then(() => {
    if (bookAdmissionLocks.get(bookId) === tail) bookAdmissionLocks.delete(bookId);
  });
  return run;
}

/** Fields the canonical release identity consumes, by the SAME precedence as v1. */
export interface ReleaseIdentityFields {
  guid?: string | undefined;
  indexerId?: number | undefined;
  infoHash?: string | undefined;
  downloadUrl: string;
}

/**
 * Canonical release identity for the single-flight key: `guid` (scoped to
 * `indexerId` when present) → `infoHash` (normalized lowercase) → raw
 * `downloadUrl`. Mirrors v1's `canonicalReleaseIdentity` so the internal grab
 * request carries the SAME identity contract — a request→request comparison, not
 * a request-vs-persisted-row one (F24).
 */
export function canonicalReleaseIdentity(f: ReleaseIdentityFields): string {
  if (f.guid) return `guid:${f.indexerId ?? ''}:${f.guid}`;
  if (f.infoHash) return `hash:${f.infoHash.toLowerCase()}`;
  return `url:${f.downloadUrl}`;
}

// ----------------------------------------------------------------------------
// Single-flight replace coalescing
//
// A process-local map holds the IN-FLIGHT promise of a replace operation keyed on
// `(bookId, canonicalReleaseIdentity)`. Only requests that arrive WHILE that exact
// promise is still pending join it and share its resolved `downloadId`
// (`created=false`); the entry is EVICTED the moment the promise settles (resolve
// OR reject). Coalescing is concurrency-only — there is NO post-settlement dedup
// (F32/F36): a re-grab after the operation settled finds no entry and proceeds fresh.
// ----------------------------------------------------------------------------

const inFlightReplaces = new Map<string, Promise<number>>();

export interface SingleFlightResult {
  downloadId: number;
  /** `true` for the request that actually ran the op; `false` for a coalesced waiter. */
  created: boolean;
}

/**
 * Run `op` under single-flight coalescing on `key`. If an identical operation is
 * already in flight, JOIN it and return its resolved `downloadId` as
 * `created=false`; otherwise run `op`, publish its promise for concurrent waiters,
 * and evict on settle. A rejection propagates to the winner AND every joined waiter.
 */
export async function singleFlightReplace(key: string, op: () => Promise<number>): Promise<SingleFlightResult> {
  const existing = inFlightReplaces.get(key);
  if (existing) {
    const downloadId = await existing;
    return { downloadId, created: false };
  }

  const promise = op();
  inFlightReplaces.set(key, promise);
  try {
    const downloadId = await promise;
    return { downloadId, created: true };
  } finally {
    // Evict on settle (resolve OR reject), but only if we still own the slot.
    if (inFlightReplaces.get(key) === promise) inFlightReplaces.delete(key);
  }
}

/** Test/introspection helper — whether an in-flight entry currently exists. */
export function hasInFlightReplace(key: string): boolean {
  return inFlightReplaces.has(key);
}
