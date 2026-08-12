import { useSyncExternalStore } from 'react';
import type { MergeDisplayPhase, MergeStateSnapshot } from '@shared/schemas/sse-events.js';

export type MergeOutcome = 'success' | 'error' | 'cancelled';

export interface MergeProgress {
  phase: MergeDisplayPhase;
  percentage?: number;
  position?: number;
  outcome?: MergeOutcome;
}

export interface MergeCardState {
  bookId: number;
  bookTitle: string;
  phase: MergeDisplayPhase;
  percentage?: number;
  position?: number;
  outcome?: MergeOutcome;
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

export function setMergeProgress(bookId: number, progress: Omit<MergeCardState, 'bookId'> | null): void {
  if (progress === null) {
    const existing = dismissTimers.get(bookId);
    if (existing) clearTimeout(existing);
    dismissTimers.delete(bookId);
    mergeProgressMap.delete(bookId);
  } else {
    // A new state supersedes any pending terminal dismissal.
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

/**
 * Replaces non-terminal state from the server snapshot. Omitted terminal cards survive until
 * their dismiss timers fire because the server broadcasts the cleared snapshot after the event.
 */
export function applyMergeStateSnapshot(snapshot: MergeStateSnapshot): void {
  const present = new Set<number>();

  for (const entry of snapshot.active) {
    present.add(entry.book_id);
    writeFromSnapshot(entry.book_id, {
      bookTitle: entry.book_title,
      phase: entry.phase,
      ...(entry.percentage !== undefined && { percentage: entry.percentage }),
    });
  }

  // FIFO — the queue position is the index, not a payload field.
  snapshot.queued.forEach((entry, index) => {
    present.add(entry.book_id);
    writeFromSnapshot(entry.book_id, {
      bookTitle: entry.book_title,
      phase: 'queued',
      position: index + 1,
    });
  });

  for (const [bookId, state] of mergeProgressMap) {
    if (present.has(bookId) || isTerminal(state)) continue;
    mergeProgressMap.delete(bookId);
  }

  notify();
}

/** Updates one entry without notifying; the caller publishes after the full snapshot. */
function writeFromSnapshot(bookId: number, state: Omit<MergeCardState, 'bookId'>): void {
  const existingTimer = dismissTimers.get(bookId);
  if (existingTimer) {
    clearTimeout(existingTimer);
    dismissTimers.delete(bookId);
  }
  mergeProgressMap.set(bookId, { bookId, ...state });
}

export function useMergeActivityCards(): MergeCardState[] {
  return useSyncExternalStore(
    subscribe,
    () => cachedSnapshot,
    () => [],
  );
}

/** Includes terminal outcomes until their dismiss window expires. */
export function useMergeProgress(bookId: number): MergeProgress | null {
  return useSyncExternalStore(
    subscribe,
    () => perBookCache.get(bookId) ?? null,
    () => null,
  );
}

export function _resetForTesting(): void {
  mergeProgressMap.clear();
  for (const timer of dismissTimers.values()) clearTimeout(timer);
  dismissTimers.clear();
  listeners.clear();
  cachedSnapshot = [];
  perBookCache.clear();
}
