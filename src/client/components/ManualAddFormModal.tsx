import { useCallback, useState } from 'react';
import { Modal } from '@/components/Modal';
import { ManualAddForm } from '@/components/ManualAddForm';
import { XIcon } from '@/components/icons';

interface ManualAddFormModalProps {
  isOpen: boolean;
  onClose: () => void;
  defaultTitle?: string | undefined;
}

export function ManualAddFormModal({ isOpen, onClose, defaultTitle }: ManualAddFormModalProps) {
  const [isPending, setIsPending] = useState(false);

  // Guarded close routed through the base Modal's Escape handling — Escape must not
  // discard form state mid-submit (the X button carries the same inline guard).
  const guardedClose = useCallback(() => {
    if (!isPending) onClose();
  }, [isPending, onClose]);

  if (!isOpen) return null;

  return (
    <Modal onClose={guardedClose} className="w-full max-w-lg">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="manual-add-form-title"
        tabIndex={-1}
        className="p-6"
      >
        <div className="flex items-center justify-end mb-2">
          <button
            type="button"
            onClick={() => { if (!isPending) onClose(); }}
            disabled={isPending}
            className="p-1.5 text-muted-foreground hover:text-foreground rounded-lg transition-colors focus-ring disabled:opacity-50 disabled:cursor-not-allowed"
            aria-label="Close"
          >
            <XIcon className="w-4 h-4" />
          </button>
        </div>
        <ManualAddForm
          defaultTitle={defaultTitle}
          onSuccess={onClose}
          onPendingChange={setIsPending}
        />
      </div>
    </Modal>
  );
}
