import { withBookAdmissionLock, withBookAdmissionLocks, hasPendingBookAdmission } from '../utils/book-admission-lock.js';

// The per-book mutex lives beside the other lock primitives in utils/ so utils-layer writers (the
// OPF sidecar) can acquire it; re-exported here because this is the name every service imports.
export { withBookAdmissionLock, withBookAdmissionLocks, hasPendingBookAdmission };

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
