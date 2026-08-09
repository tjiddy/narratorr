import { useId, useLayoutEffect, useSyncExternalStore } from 'react';

// Module state tracks dirty/pending settings forms for the navigation guard.
// useSyncExternalStore provides reactive, concurrency-safe snapshots.

interface FormEntry {
  dirty: boolean;
  pending: boolean;
  label: string;
}

export interface DirtyFormsState {
  dirtyLabels: string[];
  anyPending: boolean;
}

const registry = new Map<string, FormEntry>();
const listeners = new Set<() => void>();

// getSnapshot must retain its reference between notifications or React loops.
let cachedSnapshot: DirtyFormsState = { dirtyLabels: [], anyPending: false };

function computeSnapshot(): DirtyFormsState {
  const dirtyLabels: string[] = [];
  let anyPending = false;
  for (const entry of registry.values()) {
    if (entry.dirty) dirtyLabels.push(entry.label);
    if (entry.pending) anyPending = true;
  }
  return { dirtyLabels, anyPending };
}

function notify(): void {
  cachedSnapshot = computeSnapshot();
  for (const listener of listeners) listener();
}

function subscribe(callback: () => void): () => void {
  listeners.add(callback);
  return () => {
    listeners.delete(callback);
  };
}

function getSnapshot(): DirtyFormsState {
  return cachedSnapshot;
}

// Register for the mounted lifetime. Commit-phase writes avoid phantom entries from
// restarted renders; clean forms remain registered until unmount.
export function useTrackedForm({
  isDirty,
  isPending,
  label,
}: {
  isDirty: boolean;
  isPending: boolean;
  label: string;
}): void {
  const id = useId();
  useLayoutEffect(() => {
    registry.set(id, { dirty: isDirty, pending: isPending, label });
    notify();
    return () => {
      registry.delete(id);
      notify();
    };
  }, [id, isDirty, isPending, label]);
}

export function useDirtyFormsState(): DirtyFormsState {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

export function _resetForTesting(): void {
  registry.clear();
  cachedSnapshot = { dirtyLabels: [], anyPending: false };
  for (const listener of listeners) listener();
  listeners.clear();
}
