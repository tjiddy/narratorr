import { canonicalPath } from './path-identity.js';
import { withPathWriteLock } from './path-write-lock.js';

/**
 * The claim-key protocol (#2301). A **claim key** names the folder (or pointer file) a `books` row
 * holds or is about to hold, and its participants are exactly rename and the three destroyers —
 * book deletion, wrong-release rejection, and the re-import old-path cleanup. Nothing else takes
 * one; import and merge stay outside the protocol by design (see the issue's Out of Scope).
 *
 * Two rules keep it deadlock-free:
 *  - No enrolled operation holds two claim keys at once, except `renameBook`, which takes its
 *    source/target pair through one sorted `withPathWriteLocks` acquisition.
 *  - Acquisition is one-directional: a claim-key holder may nest a FILE key (the EXDEV sidecar
 *    fallback), but a file-key holder never acquires anything further.
 */
export const MAX_CLAIM_KEY_REACQUIRES = 3;

/** Sustained churn: the locked path was stale on every attempt. Callers take their failure arm. */
export class ClaimKeyChurnError extends Error {
  constructor(public readonly lastKey: string) {
    super(`Book path changed on every attempt after ${MAX_CLAIM_KEY_REACQUIRES} re-acquisitions (last key "${lastKey}")`);
    this.name = 'ClaimKeyChurnError';
  }
}

/**
 * Exactly {@link canonicalPath} and not a second transform: if ownership identity and lock
 * identity disagree, two operations the ownership fence says contend can enter separate critical
 * sections and interleave.
 */
export function claimLockKey(bookPath: string): string {
  return canonicalPath(bookPath);
}

/**
 * Read the path, acquire its claim key, re-read under the lock, and act only if the row still
 * names the locked folder — the freshness rule every destroyer shares. A path that moved between
 * the two reads releases the key and re-acquires on the fresh one rather than nesting a second
 * claim key, bounded by {@link MAX_CLAIM_KEY_REACQUIRES}.
 *
 * `resolvePath` returning null means there is nothing on disk to claim; `op` still runs (with
 * null) so the caller's DB half is not skipped.
 */
export async function withFreshClaimLock<T>(
  resolvePath: () => Promise<string | null>,
  op: (lockedPath: string | null) => Promise<T>,
): Promise<T> {
  let lastKey = '';
  for (let attempt = 0; attempt <= MAX_CLAIM_KEY_REACQUIRES; attempt++) {
    const planned = await resolvePath();
    if (planned === null) return op(null);

    const key = claimLockKey(planned);
    lastKey = key;
    const outcome = await withPathWriteLock<{ stale: true } | { stale: false; value: T }>(key, async () => {
      const fresh = await resolvePath();
      if (fresh === null || claimLockKey(fresh) !== key) return { stale: true };
      return { stale: false, value: await op(fresh) };
    });
    if (!outcome.stale) return outcome.value;
  }
  throw new ClaimKeyChurnError(lastKey);
}
