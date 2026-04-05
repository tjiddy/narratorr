import { useEffect, useRef, useState, useCallback, type RefObject, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

type Position = { top: number; left: number };

function computePosition(rect: DOMRect): Position {
  return {
    top: rect.bottom + window.scrollY + 4,
    left: rect.left + window.scrollX,
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
  inModal?: boolean;
  children: ReactNode;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<Position>({ top: 0, left: 0 });

  const updatePosition = useCallback(() => {
    if (triggerRef.current) {
      setPosition(computePosition(triggerRef.current.getBoundingClientRect()));
    }
  }, [triggerRef]);

  // Compute position when opening; recompute on scroll/resize
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

  // Close on outside click — dual-ref: close only when click is outside BOTH trigger and panel
  useEffect(() => {
    function handleMouseDown(e: MouseEvent) {
      const target = e.target as Node;
      if (!triggerRef.current?.contains(target) && !panelRef.current?.contains(target)) {
        onClose();
      }
    }
    if (open) document.addEventListener('mousedown', handleMouseDown);
    return () => document.removeEventListener('mousedown', handleMouseDown);
  }, [open, onClose, triggerRef]);

  // Close on Escape
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
