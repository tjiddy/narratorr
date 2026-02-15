import { useRef } from 'react';
import { useEscapeKey } from '@/hooks/useEscapeKey';

interface ConfirmModalProps {
  isOpen: boolean;
  title: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  onConfirm: () => void;
  onCancel: () => void;
}

function AlertTriangleIcon({ className = '' }: { className?: string }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
    >
      <path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z" />
      <path d="M12 9v4" />
      <path d="M12 17h.01" />
    </svg>
  );
}

export function ConfirmModal({
  isOpen,
  title,
  message,
  confirmLabel = 'Delete',
  cancelLabel = 'Cancel',
  onConfirm,
  onCancel,
}: ConfirmModalProps) {
  const modalRef = useRef<HTMLDivElement>(null);
  useEscapeKey(isOpen, onCancel, modalRef);

  if (!isOpen) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 animate-fade-in"
      onClick={onCancel}
    >
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" />

      {/* Modal */}
      <div
        ref={modalRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="confirm-modal-title"
        aria-describedby="confirm-modal-description"
        className="relative w-full max-w-md glass-card rounded-2xl p-6 shadow-2xl animate-fade-in-up"
        onClick={(e) => e.stopPropagation()}
        tabIndex={-1}
      >
        {/* Icon */}
        <div className="flex items-center justify-center w-12 h-12 mx-auto mb-4 bg-destructive/10 rounded-full">
          <AlertTriangleIcon className="w-6 h-6 text-destructive" />
        </div>

        {/* Content */}
        <div className="text-center mb-6">
          <h3 id="confirm-modal-title" className="font-display text-xl font-semibold mb-2">{title}</h3>
          <p id="confirm-modal-description" className="text-muted-foreground">{message}</p>
        </div>

        {/* Actions */}
        <div className="flex flex-col-reverse sm:flex-row gap-3">
          <button
            onClick={onCancel}
            className="flex-1 px-4 py-3 text-sm font-medium border border-border rounded-xl hover:bg-muted transition-all focus-ring"
          >
            {cancelLabel}
          </button>
          <button
            onClick={onConfirm}
            className="flex-1 px-4 py-3 text-sm font-medium bg-destructive text-destructive-foreground rounded-xl hover:opacity-90 transition-all focus-ring"
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
