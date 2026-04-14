import { useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useFocusTrap } from '@/hooks/useFocusTrap';

interface ModalProps {
  onClose?: () => void;
  closeOnBackdropClick?: boolean;
  className?: string;
  scrollable?: boolean;
  children: ReactNode;
}

export function Modal({ onClose, closeOnBackdropClick = true, className = '', scrollable = false, children }: ModalProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  useFocusTrap(true, panelRef);

  const panelClasses = [
    'relative glass-card rounded-2xl shadow-2xl animate-fade-in-up outline-none',
    scrollable ? 'flex flex-col max-h-[85vh]' : '',
    className,
  ]
    .filter(Boolean)
    .join(' ');

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 animate-fade-in"
      onClick={closeOnBackdropClick ? onClose : undefined}
    >
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-black/80 backdrop-blur-sm"
        data-testid="modal-backdrop"
      />

      {/* Panel */}
      <div
        ref={panelRef}
        tabIndex={-1}
        className={panelClasses}
        onClick={(e) => e.stopPropagation()}
      >
        {children}
      </div>
    </div>,
    document.body,
  );
}
