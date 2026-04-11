import { useState } from 'react';
import { Link } from 'react-router-dom';
import { toast } from 'sonner';
import { api, type RenameCount } from '@/lib/api';
import { getErrorMessage } from '@/lib/error-message.js';
import { FolderIcon } from '@/components/icons';
import { useBulkOperation } from '../../hooks/useBulkOperation.js';
import { ConfirmModal } from '@/components/ConfirmModal';

type PendingOp = 'rename' | 'retag' | null;
type ModalCount = RenameCount | number;

async function fetchCountForOp(op: 'rename' | 'retag'): Promise<ModalCount> {
  if (op === 'rename') {
    return api.getBulkRenameCount();
  }
  const r = await api.getBulkRetagCount();
  return r.total;
}

const MODAL_LABELS: Record<NonNullable<PendingOp>, { title: string; message: (data: ModalCount) => string; confirmLabel: string }> = {
  rename: {
    title: 'Rename All Books?',
    message: (data) => {
      const { mismatched: n, alreadyMatching: m } = data as RenameCount;
      return `Rename ${n} ${n !== 1 ? 'books' : 'book'} to match the current folder format? ${m} ${m !== 1 ? 'books' : 'book'} already match and will be skipped.`;
    },
    confirmLabel: 'Rename All',
  },
  retag: {
    title: 'Re-tag All Books?',
    message: (n) => `This will re-write audio tags for ${n as number} ${(n as number) !== 1 ? 'books' : 'book'}.`,
    confirmLabel: 'Re-tag All',
  },
};

function Spinner() {
  return (
    <svg
      className="w-3.5 h-3.5 animate-spin"
      xmlns="http://www.w3.org/2000/svg"
      fill="none"
      viewBox="0 0 24 24"
      aria-hidden="true"
    >
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
      <path
        className="opacity-75"
        fill="currentColor"
        d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
      />
    </svg>
  );
}

interface BulkButtonProps {
  label: string;
  runningLabel: string;
  isThisRunning: boolean;
  isAnyRunning: boolean;
  isDisabled?: boolean;
  disabledReason?: string;
  progress?: { completed: number; total: number };
  onClick: () => void;
}

function BulkButton({
  label,
  runningLabel,
  isThisRunning,
  isAnyRunning,
  isDisabled,
  disabledReason,
  progress,
  onClick,
}: BulkButtonProps) {
  const disabled = isDisabled || isAnyRunning;
  const title = isAnyRunning && !isThisRunning
    ? 'A bulk operation is already running.'
    : isDisabled && disabledReason
      ? disabledReason
      : undefined;

  return (
    <button
      type="button"
      disabled={disabled}
      title={title}
      onClick={onClick}
      className="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium glass-card rounded-xl hover:border-primary/30 hover:text-primary transition-all focus-ring disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:border-border/30 disabled:hover:text-foreground"
    >
      {isThisRunning && <Spinner />}
      {isThisRunning && progress
        ? `${runningLabel} ${progress.completed}/${progress.total}`
        : label}
    </button>
  );
}

export function BulkOperationsSection() {
  const { isRunning, jobType, progress, startJob } = useBulkOperation();
  const [pendingOp, setPendingOp] = useState<PendingOp>(null);
  const [modalCount, setModalCount] = useState<ModalCount | null>(null);
  const [isLoadingCount, setIsLoadingCount] = useState(false);

  const anyBusy = isRunning || isLoadingCount;

  async function handleOperationClick(op: 'rename' | 'retag') {
    setIsLoadingCount(true);
    try {
      const count = await fetchCountForOp(op);
      setModalCount(count);
      setPendingOp(op);
    } catch (error: unknown) {
      toast.error(getErrorMessage(error, 'Failed to fetch operation count'));
    } finally {
      setIsLoadingCount(false);
    }
  }

  async function handleConfirm() {
    if (!pendingOp) return;
    const op = pendingOp;
    setPendingOp(null);
    setModalCount(null);
    await startJob(op);
  }

  function handleCancel() {
    setPendingOp(null);
    setModalCount(null);
  }

  const modal = pendingOp ? MODAL_LABELS[pendingOp] : null;

  return (
    <div className="mt-4 pt-4 border-t border-border/30 space-y-3">
      <p className="text-sm font-medium text-foreground">Library Actions</p>
      <div className="flex flex-wrap gap-2">
        <Link
          to="/library-import"
          className="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium glass-card rounded-xl hover:border-primary/30 hover:text-primary transition-all focus-ring"
        >
          <FolderIcon className="w-3.5 h-3.5" />
          Scan Library
        </Link>
        <BulkButton
          label="Rename All Books"
          runningLabel="Renaming..."
          isThisRunning={isRunning && jobType === 'rename'}
          isAnyRunning={anyBusy}
          progress={progress}
          onClick={() => handleOperationClick('rename')}
        />
        <BulkButton
          label="Re-tag All Books"
          runningLabel="Re-tagging..."
          isThisRunning={isRunning && jobType === 'retag'}
          isAnyRunning={anyBusy}
          progress={progress}
          onClick={() => handleOperationClick('retag')}
        />
      </div>
      {progress.failures > 0 && (
        <p className="text-xs text-destructive">{progress.failures} failure{progress.failures !== 1 ? 's' : ''}</p>
      )}
      {modal && (
        <ConfirmModal
          isOpen={pendingOp !== null}
          title={modal.title}
          message={modal.message(modalCount ?? 0)}
          confirmLabel={modal.confirmLabel}
          cancelLabel="Cancel"
          onConfirm={handleConfirm}
          onCancel={handleCancel}
        />
      )}
    </div>
  );
}
