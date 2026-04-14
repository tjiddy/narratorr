import { useState, useCallback } from 'react';

const MODAL_KEYS = [
  'search',
  'edit',
  'confirmRename',
  'confirmRetag',
  'confirmMerge',
  'confirmDelete',
  'confirmWrongRelease',
] as const;

export type BookModalKey = (typeof MODAL_KEYS)[number];

type ModalState = Record<BookModalKey, boolean>;

const INITIAL_STATE: ModalState = Object.fromEntries(
  MODAL_KEYS.map((key) => [key, false]),
) as ModalState;

export function useBookModals() {
  const [modals, setModals] = useState<ModalState>(INITIAL_STATE);

  const open = useCallback((key: BookModalKey) => {
    setModals((prev) => ({ ...prev, [key]: true }));
  }, []);

  const close = useCallback((key: BookModalKey) => {
    setModals((prev) => ({ ...prev, [key]: false }));
  }, []);

  return { modals, open, close };
}
