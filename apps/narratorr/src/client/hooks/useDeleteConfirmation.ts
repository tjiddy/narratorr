import { useState, useCallback } from 'react';

/**
 * Manages the confirm-before-delete pattern used with ConfirmModal.
 * Tracks which item is targeted for deletion and provides handlers
 * for triggering and cancelling the confirmation.
 */
export function useDeleteConfirmation<T>() {
  const [target, setTarget] = useState<T | null>(null);

  const requestDelete = useCallback((item: T) => setTarget(item), []);
  const cancel = useCallback(() => setTarget(null), []);
  const confirm = useCallback(() => {
    const item = target;
    setTarget(null);
    return item;
  }, [target]);

  return {
    target,
    isOpen: target !== null,
    requestDelete,
    cancel,
    confirm,
  };
}
