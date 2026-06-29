import { useState } from 'react';
import { Link } from 'react-router-dom';
import { toast } from 'sonner';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { queryKeys } from '@/lib/queryKeys';
import { useBookStats } from '@/hooks/useLibrary';
import { getErrorMessage } from '@/lib/error-message.js';
import { FolderIcon } from '@/components/icons';
import { useBulkOperation } from '../../hooks/useBulkOperation.js';
import { ConfirmModal } from '@/components/ConfirmModal';
import { BulkRenameModal } from './BulkRenameModal.js';

type PendingOp = 'rename' | 'retag' | 'removeMissing' | 'writeSidecars' | null;

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

function ImportExistingLibraryLink() {
  return (
    <Link
      to="/library-import"
      className="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium glass-card rounded-xl hover:border-primary/30 hover:text-primary transition-all focus-ring"
    >
      <FolderIcon className="w-3.5 h-3.5" />
      Import Existing Library
    </Link>
  );
}

function RefreshLibraryButton({ busy, onClick }: { busy: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      disabled={busy}
      onClick={onClick}
      className="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium glass-card rounded-xl hover:border-primary/30 hover:text-primary transition-all focus-ring disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:border-border/30 disabled:hover:text-foreground"
    >
      {busy && <Spinner />}
      {busy ? 'Refreshing...' : 'Refresh Library'}
    </button>
  );
}

function RemoveMissingBooksButton({ busy, onClick }: { busy: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      disabled={busy}
      onClick={onClick}
      className="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium glass-card rounded-xl hover:border-destructive/30 hover:text-destructive transition-all focus-ring disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:border-border/30 disabled:hover:text-foreground"
    >
      {busy && <Spinner />}
      {busy ? 'Removing...' : 'Remove Missing Books'}
    </button>
  );
}

function useRefreshLibraryMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => api.rescanLibrary(),
    onSuccess: (data) => {
      toast.success(`Scanned: ${data.scanned} books. Missing: ${data.missing} books. Restored: ${data.restored} books.`);
      queryClient.invalidateQueries({ queryKey: queryKeys.books() });
    },
    onError: (error: unknown) => {
      toast.error(getErrorMessage(error));
    },
  });
}

function useRemoveMissingMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => api.deleteMissingBooks(),
    onSuccess: (data) => {
      toast.success(`Removed ${data.deleted} missing book${data.deleted !== 1 ? 's' : ''}`);
      queryClient.invalidateQueries({ queryKey: queryKeys.books() });
    },
    onError: (error: unknown) => {
      toast.error(getErrorMessage(error));
    },
  });
}

interface BulkOperationModalsProps {
  pendingOp: PendingOp;
  retagCount: number | null;
  missingCount: number;
  onStartRename: () => void;
  onConfirm: () => void;
  onCancel: () => void;
}

/** The three confirmation modals, kept out of the main section to bound its complexity. */
function BulkOperationModals({ pendingOp, retagCount, missingCount, onStartRename, onConfirm, onCancel }: BulkOperationModalsProps) {
  if (pendingOp === 'rename') {
    return <BulkRenameModal isOpen onClose={onCancel} onConfirm={onStartRename} />;
  }
  if (pendingOp === 'retag') {
    const n = retagCount ?? 0;
    return (
      <ConfirmModal
        isOpen
        title="Re-tag All Books?"
        message={`This will re-write audio tags for ${n} ${n !== 1 ? 'books' : 'book'}.`}
        confirmLabel="Re-tag All"
        cancelLabel="Cancel"
        onConfirm={onConfirm}
        onCancel={onCancel}
      />
    );
  }
  if (pendingOp === 'removeMissing') {
    return (
      <ConfirmModal
        isOpen
        title="Remove Missing Books?"
        message={`Remove ${missingCount} missing book${missingCount !== 1 ? 's' : ''} from Narratorr? Files will not be deleted.`}
        confirmLabel="Remove"
        cancelLabel="Cancel"
        onConfirm={onConfirm}
        onCancel={onCancel}
      />
    );
  }
  if (pendingOp === 'writeSidecars') {
    return (
      <ConfirmModal
        isOpen
        title="Write Metadata Sidecars?"
        message="Write a metadata.opf into each imported book's folder, refreshing it from the current library data, and download any cover that hasn't been saved locally yet. Foreign metadata.opf files are left untouched. This helps media servers like Audiobookshelf and Plex read your metadata."
        confirmLabel="Write Sidecars"
        cancelLabel="Cancel"
        onConfirm={onConfirm}
        onCancel={onCancel}
      />
    );
  }
  return null;
}

export function BulkOperationsSection() {
  const { isRunning, jobType, progress, startJob } = useBulkOperation();
  const [pendingOp, setPendingOp] = useState<PendingOp>(null);
  const [retagCount, setRetagCount] = useState<number | null>(null);
  const [isLoadingCount, setIsLoadingCount] = useState(false);

  const { data: stats } = useBookStats();
  const missingCount = stats?.counts.missing ?? 0;

  const refreshMutation = useRefreshLibraryMutation();
  const removeMissingMutation = useRemoveMissingMutation();

  const anyBulkBusy = isRunning || isLoadingCount;

  // Rename opens the preview modal directly — it fetches its own from→to diff.
  function handleRenameClick() {
    setPendingOp('rename');
  }

  // Retag still pre-fetches a count for its count-only confirm.
  async function handleRetagClick() {
    setIsLoadingCount(true);
    try {
      const { total } = await api.getBulkRetagCount();
      setRetagCount(total);
      setPendingOp('retag');
    } catch (error: unknown) {
      toast.error(getErrorMessage(error));
    } finally {
      setIsLoadingCount(false);
    }
  }

  function handleConfirm() {
    if (pendingOp === 'removeMissing') {
      setPendingOp(null);
      removeMissingMutation.mutate();
      return;
    }
    if (pendingOp === 'retag') {
      setPendingOp(null);
      setRetagCount(null);
      void startJob('retag');
      return;
    }
    if (pendingOp === 'writeSidecars') {
      setPendingOp(null);
      void startJob('write_metadata_sidecars');
    }
  }

  function handleCancel() {
    setPendingOp(null);
    setRetagCount(null);
  }

  return (
    <div className="mt-4 pt-4 border-t border-border/30 space-y-3">
      <p className="text-sm font-medium text-foreground">Library Actions</p>
      <div className="flex flex-wrap gap-2">
        <ImportExistingLibraryLink />
        <RefreshLibraryButton busy={refreshMutation.isPending} onClick={() => refreshMutation.mutate()} />
        <BulkButton
          label="Rename All Books"
          runningLabel="Renaming..."
          isThisRunning={isRunning && jobType === 'rename'}
          isAnyRunning={anyBulkBusy}
          progress={progress}
          onClick={handleRenameClick}
        />
        <BulkButton
          label="Re-tag All Books"
          runningLabel="Re-tagging..."
          isThisRunning={isRunning && jobType === 'retag'}
          isAnyRunning={anyBulkBusy}
          progress={progress}
          onClick={handleRetagClick}
        />
        <BulkButton
          label="Write/refresh metadata sidecars"
          runningLabel="Writing sidecars..."
          isThisRunning={isRunning && jobType === 'write_metadata_sidecars'}
          isAnyRunning={anyBulkBusy}
          progress={progress}
          onClick={() => setPendingOp('writeSidecars')}
        />
        {missingCount > 0 && (
          <RemoveMissingBooksButton
            busy={removeMissingMutation.isPending}
            onClick={() => setPendingOp('removeMissing')}
          />
        )}
      </div>
      <p className="text-xs text-muted-foreground">
        Write/refresh metadata sidecars saves a <code>metadata.opf</code> into each imported book&apos;s folder
        and downloads any cover not already saved locally, so media servers (Audiobookshelf, Plex) read your
        library&apos;s metadata. It never overwrites a foreign <code>metadata.opf</code> and leaves other files
        in place.
      </p>
      {progress.failures > 0 && (
        <p className="text-xs text-destructive">{progress.failures} failure{progress.failures !== 1 ? 's' : ''}</p>
      )}
      <BulkOperationModals
        pendingOp={pendingOp}
        retagCount={retagCount}
        missingCount={missingCount}
        onStartRename={() => {
          setPendingOp(null);
          void startJob('rename');
        }}
        onConfirm={handleConfirm}
        onCancel={handleCancel}
      />
    </div>
  );
}
