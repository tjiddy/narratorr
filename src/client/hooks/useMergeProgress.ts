import { useSyncExternalStore } from 'react';

export interface MergeProgress {
  phase: string;
  percentage?: number;
}

const mergeProgressMap = new Map<number, MergeProgress | null>();
const listeners = new Set<() => void>();

function notify() {
  for (const listener of listeners) listener();
}

/** Called by useEventSource to update merge progress for a book. Pass null to clear. */
export function setMergeProgress(bookId: number, progress: MergeProgress | null): void {
  if (progress === null) {
    mergeProgressMap.delete(bookId);
  } else {
    mergeProgressMap.set(bookId, progress);
  }
  notify();
}

function subscribe(callback: () => void): () => void {
  listeners.add(callback);
  return () => { listeners.delete(callback); };
}

/** Reactive hook — returns current merge progress for a book, or null if no merge in progress. */
export function useMergeProgress(bookId: number): MergeProgress | null {
  return useSyncExternalStore(
    subscribe,
    () => mergeProgressMap.get(bookId) ?? null,
    () => null,
  );
}
