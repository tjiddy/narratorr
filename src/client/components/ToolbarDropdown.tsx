import { useEffect, useRef, useState, useCallback, type RefObject, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useClickOutside } from '@/hooks/useClickOutside';

type Position = { top: number; left: number };

const VIEWPORT_MARGIN = 8;

function computePosition(rect: DOMRect, panelWidth: number, viewportWidth: number): Position {
  // Anchor to the trigger and clamp to the viewport. Width 0 means layout is
  // unavailable, so skip the right clamp.
  const maxLeft = viewportWidth > 0 ? viewportWidth - panelWidth - VIEWPORT_MARGIN : Infinity;
  return {
    top: rect.bottom + window.scrollY + 4,
    left: Math.max(VIEWPORT_MARGIN, Math.min(rect.left + window.scrollX, maxLeft)),
  };
}

export function ToolbarDropdown({
  triggerRef,
  open,
  onClose,
  inModal,
  children,
}: {
  triggerRef: RefObject<HTMLElement | null>;
  open: boolean;
  onClose: () => void;
  inModal?: boolean | undefined;
  children: ReactNode;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<Position>({ top: 0, left: 0 });

  const updatePosition = useCallback(() => {
    if (!triggerRef.current) return;
    const panelWidth = panelRef.current?.getBoundingClientRect().width ?? 0;
    setPosition(
      computePosition(
        triggerRef.current.getBoundingClientRect(),
        panelWidth,
        document.documentElement.clientWidth,
      ),
    );
  }, [triggerRef]);

  useEffect(() => {
    if (!open) return;
    updatePosition();
    window.addEventListener('scroll', updatePosition, true);
    window.addEventListener('resize', updatePosition);
    return () => {
      window.removeEventListener('scroll', updatePosition, true);
      window.removeEventListener('resize', updatePosition);
    };
  }, [open, updatePosition]);

  // The portaled panel and its trigger both count as inside.
  useClickOutside([triggerRef, panelRef], onClose, open);

  // Capture first so Escape closes only the dropdown, not its parent modal.
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopImmediatePropagation();
        onClose();
      }
    }
    if (open) document.addEventListener('keydown', handleKeyDown, true);
    return () => document.removeEventListener('keydown', handleKeyDown, true);
  }, [open, onClose]);

  if (!open) return null;

  return createPortal(
    <div
      ref={panelRef}
      className={`fixed ${inModal ? 'z-50' : 'z-30'}`}
      style={{ top: `${position.top}px`, left: `${position.left}px` }}
    >
      {children}
    </div>,
    document.body,
  );
}
