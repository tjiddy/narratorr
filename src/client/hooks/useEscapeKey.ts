import { useEffect, type RefObject } from 'react';

export function useEscapeKey(
  isOpen: boolean,
  onEscape: () => void,
  focusRef?: RefObject<HTMLElement | null>,
) {
  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !e.defaultPrevented) onEscape();
    };
    document.addEventListener('keydown', handleKeyDown);
    focusRef?.current?.focus();
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, onEscape, focusRef]);
}
