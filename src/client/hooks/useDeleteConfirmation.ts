import { useState, useCallback } from 'react';

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
