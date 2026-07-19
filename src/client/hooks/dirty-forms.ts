import { useId, useLayoutEffect, useSyncExternalStore } from 'react';

// Module-level dirty-form registry. Every tracked settings card registers a
// `useId`-keyed entry describing whether it holds unsaved edits (`dirty`), has a
// save in flight (`pending`), and its display `label`. The unsaved-changes guard
// reads the derived snapshot to decide whether to intercept navigation and which
// card names to show. Exposed via `useSyncExternalStore` so React re-renders on
// change (see learning: module-state-use-sync-external-store — a bare `let`
// won't trigger re-renders and tears across concurrent renders).

interface FormEntry {
  dirty: boolean;
  pending: boolean;
  label: string;
}

export interface DirtyFormsState {
  /** Labels of every entry currently `dirty === true`, in insertion order. */
  dirtyLabels: string[];
  /** True when any tracked form has a save in flight. */
  anyPending: boolean;
}

const registry = new Map<string, FormEntry>();
const listeners = new Set<() => void>();

// Cached immutable snapshot — rebuilt only inside notify(). `useSyncExternalStore`
// requires getSnapshot to return a stable reference between changes or it loops.
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

/**
 * Register a form with the dirty registry for the lifetime of the calling
 * component. The entry is retained while mounted regardless of `isDirty`/
 * `isPending` (a clean-again form stays in the Map with `dirty: false`), and
 * removed on unmount.
 *
 * Synchronization happens in commit phase (`useLayoutEffect`), never during
 * render: a render-phase write to the module store is a non-local mutation that
 * violates React's purity rules and, because React can restart or abandon a
 * render, could leave a phantom entry that never gets cleaned up.
 */
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

/** Reactive snapshot of the dirty registry for the navigation guard. */
export function useDirtyFormsState(): DirtyFormsState {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

/** Reset store state for testing. Notifies any active subscribers before clearing them. */
export function _resetForTesting(): void {
  registry.clear();
  cachedSnapshot = { dirtyLabels: [], anyPending: false };
  for (const listener of listeners) listener();
  listeners.clear();
}
