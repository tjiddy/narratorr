// Process-local locking is sufficient because Narratorr runs as one Node process.

/**
 * Serializes duplicate-check → client-add → insert per book.
 * Non-reentrant: holders must call unlocked primitives or deadlock.
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

export interface ReleaseIdentityFields {
  guid?: string | undefined;
  indexerId?: number | undefined;
  infoHash?: string | undefined;
  downloadUrl: string;
}

// Keep this precedence identical to v1's canonicalReleaseIdentity.
export function canonicalReleaseIdentity(f: ReleaseIdentityFields): string {
  if (f.guid) return `guid:${f.indexerId ?? ''}:${f.guid}`;
  if (f.infoHash) return `hash:${f.infoHash.toLowerCase()}`;
  return `url:${f.downloadUrl}`;
}

// Coalescing is concurrency-only; there is no post-settlement deduplication.

const inFlightReplaces = new Map<string, Promise<number>>();

export interface SingleFlightResult {
  downloadId: number;
  /** `true` for the request that actually ran the op; `false` for a coalesced waiter. */
  created: boolean;
}

/** Joined callers share both the result and any rejection. */
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
    // Evict on either outcome, but only while this promise owns the slot.
    if (inFlightReplaces.get(key) === promise) inFlightReplaces.delete(key);
  }
}

export function hasInFlightReplace(key: string): boolean {
  return inFlightReplaces.has(key);
}
