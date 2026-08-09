import { useEffect, type RefObject } from 'react';

// Every modal registers a document listener; this stack lets only the most recently
// opened modal handle Escape.
const escapeStack: symbol[] = [];

export function useEscapeKey(
  isOpen: boolean,
  onEscape: () => void,
  focusRef?: RefObject<HTMLElement | null>,
) {
  useEffect(() => {
    if (!isOpen) return;
    const id = Symbol('escape');
    escapeStack.push(id);
    const handleKeyDown = (e: KeyboardEvent) => {
      // Earlier preventDefault still wins over the topmost modal.
      if (e.key === 'Escape' && !e.defaultPrevented && escapeStack[escapeStack.length - 1] === id) {
        onEscape();
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    focusRef?.current?.focus();
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
      const i = escapeStack.lastIndexOf(id);
      if (i >= 0) escapeStack.splice(i, 1);
    };
  }, [isOpen, onEscape, focusRef]);
}
