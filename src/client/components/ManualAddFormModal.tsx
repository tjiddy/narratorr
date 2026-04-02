import { useCallback, useRef, useState } from 'react';
import { Modal } from '@/components/Modal';
import { ManualAddForm } from '@/components/ManualAddForm';
import { useEscapeKey } from '@/hooks/useEscapeKey';

interface ManualAddFormModalProps {
  isOpen: boolean;
  onClose: () => void;
  defaultTitle?: string;
}

export function ManualAddFormModal({ isOpen, onClose, defaultTitle }: ManualAddFormModalProps) {
  const modalRef = useRef<HTMLDivElement>(null);
  const [isPending, setIsPending] = useState(false);

  const handleEscape = useCallback(() => {
    if (!isPending) onClose();
  }, [isPending, onClose]);

  useEscapeKey(isOpen, handleEscape, modalRef);

  if (!isOpen) return null;

  return (
    <Modal onClose={onClose} closeOnBackdropClick={false} className="w-full max-w-lg">
      <div ref={modalRef} className="p-6">
        <ManualAddForm
          defaultTitle={defaultTitle}
          onSuccess={onClose}
          onPendingChange={setIsPending}
        />
      </div>
    </Modal>
  );
}
