import { useSyncExternalStore } from 'react';

export interface MergeProgress {
  phase: string;
  percentage?: number;
  position?: number;
  outcome?: 'success' | 'error' | 'cancelled';
}

export interface MergeCardState {
  bookId: number;
  bookTitle: string;
  phase: string;
  percentage?: number;
  position?: number;
  outcome?: 'success' | 'error' | 'cancelled';
  message?: string;
  error?: string;
  enrichmentWarning?: string;
}

const DISMISS_DELAY_MS = 3000;

const mergeProgressMap = new Map<number, MergeCardState>();
const dismissTimers = new Map<number, ReturnType<typeof setTimeout>>();
const listeners = new Set<() => void>();

let cachedSnapshot: MergeCardState[] = [];
const perBookCache = new Map<number, MergeProgress | null>();

function rebuildPerBookCache() {
  perBookCache.clear();
  for (const [bookId, entry] of mergeProgressMap) {
    const result: MergeProgress = { phase: entry.phase };
    if (entry.percentage !== undefined) result.percentage = entry.percentage;
    if (entry.position !== undefined) result.position = entry.position;
    if (entry.outcome !== undefined) result.outcome = entry.outcome;
    perBookCache.set(bookId, result);
  }
}

function notify() {
  cachedSnapshot = [...mergeProgressMap.values()];
  rebuildPerBookCache();
  for (const listener of listeners) listener();
}

function subscribe(callback: () => void): () => void {
  listeners.add(callback);
  return () => { listeners.delete(callback); };
}

function scheduleDismiss(bookId: number): void {
  const existing = dismissTimers.get(bookId);
  if (existing) clearTimeout(existing);

  dismissTimers.set(bookId, setTimeout(() => {
    mergeProgressMap.delete(bookId);
    dismissTimers.delete(bookId);
    notify();
  }, DISMISS_DELAY_MS));
}

function isTerminal(state: Omit<MergeCardState, 'bookId'>): boolean {
  return state.outcome !== undefined;
}

/** Called by useEventSource to update merge progress for a book. Pass null to clear. */
export function setMergeProgress(bookId: number, progress: Omit<MergeCardState, 'bookId'> | null): void {
  if (progress === null) {
    const existing = dismissTimers.get(bookId);
    if (existing) clearTimeout(existing);
    dismissTimers.delete(bookId);
    mergeProgressMap.delete(bookId);
  } else {
    // Clear any pending dismiss timer from a prior terminal state for this book
    const existingTimer = dismissTimers.get(bookId);
    if (existingTimer) {
      clearTimeout(existingTimer);
      dismissTimers.delete(bookId);
    }
    mergeProgressMap.set(bookId, { bookId, ...progress });
    if (isTerminal(progress)) {
      scheduleDismiss(bookId);
    }
  }
  notify();
}

/** Reactive hook — returns all active merge progress entries for ActivityPage. */
export function useMergeActivityCards(): MergeCardState[] {
  return useSyncExternalStore(
    subscribe,
    () => cachedSnapshot,
    () => [],
  );
}

/**
 * Reactive hook — returns current merge progress for a single book.
 * Returns progress with `outcome` field during the dismiss window for terminal entries,
 * allowing BookDetails to show fade-out animation before removal.
 */
export function useMergeProgress(bookId: number): MergeProgress | null {
  return useSyncExternalStore(
    subscribe,
    () => perBookCache.get(bookId) ?? null,
    () => null,
  );
}

/** Reset store state for testing. */
export function _resetForTesting(): void {
  mergeProgressMap.clear();
  for (const timer of dismissTimers.values()) clearTimeout(timer);
  dismissTimers.clear();
  listeners.clear();
  cachedSnapshot = [];
  perBookCache.clear();
}
