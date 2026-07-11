import { useEffect, type RefObject } from 'react';

// Topmost-modal arbitration (#1857). Nested modals each register a document-level
// keydown listener; without coordination, a single Escape would close them all
// (the outer modal's listener fires and closes it before an inner listener could
// mark the event handled). A shared stack of live handler ids lets EACH listener
// check whether it is the topmost open modal and no-op otherwise — so Escape with
// a nested confirm open closes ONLY the confirm.
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
      // Only the topmost open modal responds; still respect an earlier handler
      // that already claimed the event via preventDefault.
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
