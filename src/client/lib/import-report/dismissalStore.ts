import { useCallback, useState } from 'react';

/**
 * Stores versioned `submissionId:kind` keys with FIFO eviction and a session-memory fallback
 * when localStorage is corrupt or unavailable.
 */

export type AttentionKind = 'abandoned' | 'completed-attention';

export const DISMISSAL_STORAGE_KEY = 'narratorr.importAttentionDismissed.v1';
export const DISMISSAL_CAP = 50;

// null means localStorage is usable; an array activates the session fallback.
let memoryFallback: string[] | null = null;

export function dismissalKey(submissionId: number, kind: AttentionKind): string {
  return `${submissionId}:${kind}`;
}

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
    // Treat corrupt or unavailable storage as unavailable for this session.
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
    memoryFallback = keys;
  }
}

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
