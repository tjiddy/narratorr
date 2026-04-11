import { useRef, type ReactNode } from 'react';
import { useEscapeKey } from '@/hooks/useEscapeKey';
import { Button } from '@/components/Button';
import { Modal } from '@/components/Modal';

interface ConfirmModalProps {
  isOpen: boolean;
  title: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  confirmDisabled?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
  children?: ReactNode;
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
  confirmDisabled,
  onConfirm,
  onCancel,
  children,
}: ConfirmModalProps) {
  const modalRef = useRef<HTMLDivElement>(null);
  useEscapeKey(isOpen, onCancel, modalRef);

  if (!isOpen) return null;

  return (
    <Modal onClose={onCancel} className="w-full max-w-md p-6">
      <div
        ref={modalRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="confirm-modal-title"
        aria-describedby="confirm-modal-description"
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

        {children && (
          <div className="mb-6 flex justify-center">
            {children}
          </div>
        )}

        {/* Actions */}
        <div className="flex flex-col-reverse sm:flex-row gap-3">
          <Button
            variant="secondary"
            size="md"
            type="button"
            onClick={onCancel}
            className="flex-1 text-sm"
          >
            {cancelLabel}
          </Button>
          <Button
            variant="destructive"
            size="md"
            type="button"
            onClick={onConfirm}
            disabled={confirmDisabled}
            className="flex-1 text-sm"
          >
            {confirmLabel}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
