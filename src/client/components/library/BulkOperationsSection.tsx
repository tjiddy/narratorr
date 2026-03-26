import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { queryKeys } from '@/lib/queryKeys';
import { useBulkOperation } from '../../hooks/useBulkOperation.js';
import { ConfirmModal } from '@/components/ConfirmModal';

type PendingOp = 'rename' | 'retag' | 'convert' | null;

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
  const title = isDisabled && disabledReason ? disabledReason : undefined;

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
  const [modalCount, setModalCount] = useState<number | null>(null);
  const [isLoadingCount, setIsLoadingCount] = useState(false);

  const { data: settings } = useQuery({
    queryKey: queryKeys.settings(),
    queryFn: api.getSettings,
    staleTime: 60_000,
  });

  const ffmpegConfigured = Boolean(settings?.processing?.ffmpegPath?.trim());

  async function handleOperationClick(op: 'rename' | 'retag' | 'convert') {
    setIsLoadingCount(true);
    try {
      let count = 0;
      if (op === 'rename') {
        const r = await api.getBulkRenameCount();
        count = r.mismatched;
      } else if (op === 'retag') {
        const r = await api.getBulkRetagCount();
        count = r.total;
      } else {
        const r = await api.getBulkConvertCount();
        count = r.total;
      }
      setModalCount(count);
      setPendingOp(op);
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

  const modalLabels: Record<NonNullable<PendingOp>, { title: string; message: (n: number) => string; confirmLabel: string }> = {
    rename: {
      title: 'Rename All Books?',
      message: (n) => `This will rename ${n} book${n !== 1 ? 's' : ''} to match the current folder format.`,
      confirmLabel: 'Rename All',
    },
    retag: {
      title: 'Re-tag All Books?',
      message: (n) => `This will re-write audio tags for ${n} book${n !== 1 ? 's' : ''}.`,
      confirmLabel: 'Re-tag All',
    },
    convert: {
      title: 'Convert All to M4B?',
      message: (n) => `This will convert ${n} book${n !== 1 ? 's' : ''} to M4B format. Original files will be replaced.`,
      confirmLabel: 'Convert All',
    },
  };

  const modal = pendingOp ? modalLabels[pendingOp] : null;

  return (
    <div className="mt-4 pt-4 border-t border-border/30 space-y-3">
      <p className="text-sm font-medium text-foreground">Bulk Operations</p>
      <div className="flex flex-wrap gap-2">
        <BulkButton
          label="Rename All Books"
          runningLabel="Renaming..."
          isThisRunning={isRunning && jobType === 'rename'}
          isAnyRunning={isRunning || isLoadingCount}
          progress={progress}
          onClick={() => handleOperationClick('rename')}
        />
        <BulkButton
          label="Re-tag All Books"
          runningLabel="Re-tagging..."
          isThisRunning={isRunning && jobType === 'retag'}
          isAnyRunning={isRunning || isLoadingCount}
          progress={progress}
          onClick={() => handleOperationClick('retag')}
        />
        <BulkButton
          label="Convert All to M4B"
          runningLabel="Converting..."
          isThisRunning={isRunning && jobType === 'convert'}
          isAnyRunning={isRunning || isLoadingCount}
          isDisabled={!ffmpegConfigured}
          disabledReason="ffmpeg is not configured in Processing settings"
          progress={progress}
          onClick={() => handleOperationClick('convert')}
        />
      </div>
      {isRunning && progress.failures > 0 && (
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
