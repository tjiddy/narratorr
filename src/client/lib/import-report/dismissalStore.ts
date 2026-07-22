import { useCallback, useState } from 'react';

/**
 * Defensive, versioned attention-banner dismissal store (#1894, F55).
 *
 * Persists an ORDERED list of dismissed keys in localStorage under a versioned key.
 * Each key is `${submissionId}:${kind}` — so dismissing an `abandoned` banner does
 * NOT suppress a later `completed-attention` on the same id (distinct key,
 * re-raises), and a new submission id also re-raises. Cap = 50 with FIFO eviction
 * (oldest dropped first). All reads/writes are try/catch-guarded (the
 * `useFolderHistory` idiom); on unavailable/corrupt storage it falls back to an
 * in-memory list with identical cap + FIFO semantics (dismissals last the session).
 */

export type AttentionKind = 'abandoned' | 'completed-attention';

export const DISMISSAL_STORAGE_KEY = 'narratorr.importAttentionDismissed.v1';
export const DISMISSAL_CAP = 50;

/** Session-lifetime in-memory fallback, engaged when localStorage is unavailable. */
let memoryFallback: string[] | null = null;

export function dismissalKey(submissionId: number, kind: AttentionKind): string {
  return `${submissionId}:${kind}`;
}

/** FIFO-cap: keep the newest `DISMISSAL_CAP` (appended last), dropping the oldest. */
function cap(keys: string[]): string[] {
  return keys.length > DISMISSAL_CAP ? keys.slice(keys.length - DISMISSAL_CAP) : keys;
}

export function loadDismissedKeys(): string[] {
  if (memoryFallback) return memoryFallback;
  try {
    const raw = localStorage.getItem(DISMISSAL_STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((k): k is string => typeof k === 'string');
  } catch {
    // Corrupt/unavailable — switch to the in-memory fallback for the session.
    memoryFallback = memoryFallback ?? [];
    return memoryFallback;
  }
}

function persist(keys: string[]): void {
  if (memoryFallback) {
    memoryFallback = keys;
    return;
  }
  try {
    localStorage.setItem(DISMISSAL_STORAGE_KEY, JSON.stringify(keys));
  } catch {
    memoryFallback = keys; // storage unavailable — engage the in-memory fallback
  }
}

/** Test-only: clear the module-level in-memory fallback between cases. */
export function __resetDismissalMemory(): void {
  memoryFallback = null;
}

export function useAttentionDismissal() {
  const [keys, setKeys] = useState<string[]>(() => loadDismissedKeys());

  const dismiss = useCallback((key: string) => {
    setKeys((prev) => {
      const next = cap([...prev.filter((k) => k !== key), key]);
      persist(next);
      return next;
    });
  }, []);

  const isDismissed = useCallback((key: string) => keys.includes(key), [keys]);

  return { isDismissed, dismiss };
}
