import { type ReactNode } from 'react';

interface ModalProps {
  onClose?: () => void;
  className?: string;
  scrollable?: boolean;
  children: ReactNode;
}

export function Modal({ onClose, className = '', scrollable = false, children }: ModalProps) {
  const panelClasses = [
    'relative glass-card rounded-2xl shadow-2xl animate-fade-in-up',
    scrollable ? 'flex flex-col max-h-[85vh]' : '',
    className,
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 animate-fade-in"
      onClick={onClose}
    >
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-black/80 backdrop-blur-sm"
        data-testid="modal-backdrop"
      />

      {/* Panel */}
      <div
        className={panelClasses}
        onClick={(e) => e.stopPropagation()}
      >
        {children}
      </div>
    </div>
  );
}
