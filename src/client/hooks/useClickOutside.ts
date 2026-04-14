import { useEffect, type RefObject } from 'react';

export function useClickOutside(
  refs: RefObject<Element | null> | RefObject<Element | null>[],
  handler: () => void,
  enabled: boolean = true,
) {
  useEffect(() => {
    if (!enabled) return;

    const refArray = Array.isArray(refs) ? refs : [refs];

    const handleMouseDown = (e: MouseEvent) => {
      const target = e.target as Node;
      const isInside = refArray.some(
        (ref) => ref.current?.contains(target),
      );
      if (!isInside) handler();
    };

    document.addEventListener('mousedown', handleMouseDown);
    return () => document.removeEventListener('mousedown', handleMouseDown);
  }, [refs, handler, enabled]);
}
