import { useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useFocusTrap } from '@/hooks/useFocusTrap';
import { useEscapeKey } from '@/hooks/useEscapeKey';

interface ModalProps {
  onClose?: () => void;
  className?: string;
  scrollable?: boolean;
  children: ReactNode;
}

export function Modal({ onClose, className = '', scrollable = false, children }: ModalProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  // Fires before consumer effects — lets WelcomeModal's autofocus override initial placement
  useFocusTrap(true, panelRef);
  // Escape closes any modal that provides onClose; no-op when onClose is omitted (explicit opt-out).
  // Modal only renders while open, so isOpen = true is correct.
  useEscapeKey(true, onClose ?? (() => {}), panelRef);

  const panelClasses = [
    'relative glass-card rounded-2xl shadow-2xl animate-fade-in-up outline-none',
    scrollable ? 'flex flex-col max-h-[85vh]' : '',
    className,
  ]
    .filter(Boolean)
    .join(' ');

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 animate-fade-in">
      {/* Backdrop (visual only — does not close the modal) */}
      <div
        className="absolute inset-0 bg-black/80 backdrop-blur-sm"
        data-testid="modal-backdrop"
      />

      {/* Panel */}
      <div ref={panelRef} tabIndex={-1} className={panelClasses}>
        {children}
      </div>
    </div>,
    document.body,
  );
}
