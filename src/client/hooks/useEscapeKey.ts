import { useEffect, useRef } from 'react';

// Every modal registers a document listener; this stack lets only the most recently
// opened modal handle Escape.
const escapeStack: symbol[] = [];

export function useEscapeKey(isOpen: boolean, onEscape: () => void) {
  // Ref-held so callers may pass inline closures: with `onEscape` in the effect deps, every
  // parent re-render re-armed the effect, and its (since-removed) focus call stole the caret
  // from modal inputs on each SSE activity tick (#2605). Focus is useFocusTrap's job.
  const onEscapeRef = useRef(onEscape);
  useEffect(() => {
    onEscapeRef.current = onEscape;
  }, [onEscape]);

  useEffect(() => {
    if (!isOpen) return;
    const id = Symbol('escape');
    escapeStack.push(id);
    const handleKeyDown = (e: KeyboardEvent) => {
      // Earlier preventDefault still wins over the topmost modal.
      if (e.key === 'Escape' && !e.defaultPrevented && escapeStack[escapeStack.length - 1] === id) {
        onEscapeRef.current();
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
      const i = escapeStack.lastIndexOf(id);
      if (i >= 0) escapeStack.splice(i, 1);
    };
  }, [isOpen]);
}
