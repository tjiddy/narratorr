import { useRef } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api, RenameConflictError, type RenamePreviewResult } from '@/lib/api';
import { queryKeys } from '@/lib/queryKeys';
import { useEscapeKey } from '@/hooks/useEscapeKey';
import { Modal } from '@/components/Modal';
import { Button } from '@/components/Button';
import { LoadingSpinner } from '@/components/icons';
import { getErrorMessage } from '@/lib/error-message.js';

interface RenamePreviewModalProps {
  bookId: number;
  isOpen: boolean;
  onClose: () => void;
  onConfirm: () => void;
}

export function RenamePreviewModal({ bookId, isOpen, onClose, onConfirm }: RenamePreviewModalProps) {
  const modalRef = useRef<HTMLDivElement>(null);
  useEscapeKey(isOpen, onClose, modalRef);

  const { data, isLoading, error } = useQuery({
    queryKey: queryKeys.bookRenamePreview(bookId),
    queryFn: () => api.getBookRenamePreview(bookId),
    enabled: isOpen,
    staleTime: 0,
    gcTime: 0,
    refetchOnMount: 'always',
    retry: false,
  });

  if (!isOpen) return null;

  const conflict = error instanceof RenameConflictError ? error : null;
  const isEmpty =
    data !== undefined && data.folderMove === null && data.fileRenames.length === 0;
  const canRename = data !== undefined && !conflict && !isEmpty;

  return (
    <Modal onClose={onClose} className="w-full max-w-2xl p-6" scrollable>
      <div
        ref={modalRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="rename-preview-modal-title"
        tabIndex={-1}
        className="flex flex-col min-h-0"
      >
        <div className="text-center mb-4 shrink-0">
          <h3 id="rename-preview-modal-title" className="font-display text-xl font-semibold">
            Rename files?
          </h3>
        </div>

        <div className="flex-1 min-h-0 overflow-y-auto">
          {isLoading && (
            <div className="flex items-center justify-center py-12 text-muted-foreground">
              <LoadingSpinner className="w-5 h-5" />
              <span className="ml-2 text-sm">Building preview…</span>
            </div>
          )}

          {conflict && <ConflictBanner conflict={conflict} />}

          {error && !conflict && (
            <p
              role="alert"
              className="text-sm text-destructive bg-destructive/10 rounded-lg px-4 py-3"
            >
              {getErrorMessage(error)}
            </p>
          )}

          {data && (
            <PreviewBody plan={data} isEmpty={isEmpty} />
          )}
        </div>

        <div className="flex flex-col-reverse sm:flex-row gap-3 mt-6 shrink-0">
          <Button variant="secondary" size="md" type="button" onClick={onClose} className="flex-1 text-sm">
            Cancel
          </Button>
          {canRename && (
            <Button
              variant="primary"
              size="md"
              type="button"
              onClick={() => {
                onClose();
                onConfirm();
              }}
              className="flex-1 text-sm"
            >
              Rename
            </Button>
          )}
        </div>
      </div>
    </Modal>
  );
}

function PreviewBody({ plan, isEmpty }: { plan: RenamePreviewResult; isEmpty: boolean }) {
  return (
    <div className="space-y-5">
      <PreviewBanner plan={plan} />
      {plan.folderMove && <FolderMoveSection from={plan.folderMove.from} to={plan.folderMove.to} />}
      {plan.fileRenames.length > 0 && <FileRenamesSection renames={plan.fileRenames} />}
      {isEmpty && (
        <p className="text-sm text-muted-foreground text-center py-4">
          Files already match your template — nothing to rename.
        </p>
      )}
    </div>
  );
}

function PreviewBanner({ plan }: { plan: RenamePreviewResult }) {
  return (
    <div className="text-xs space-y-1 text-muted-foreground bg-muted/40 rounded-lg px-4 py-3">
      <p>
        <span className="font-medium text-foreground">All paths are relative to:</span>{' '}
        <code className="font-mono">{plan.libraryRoot}</code>
      </p>
      <p>
        <span className="font-medium text-foreground">Folder pattern:</span>{' '}
        <code className="font-mono">{plan.folderFormat}</code>
      </p>
      <p>
        <span className="font-medium text-foreground">File pattern:</span>{' '}
        <code className="font-mono">{plan.fileFormat}</code>
      </p>
    </div>
  );
}

function FolderMoveSection({ from, to }: { from: string; to: string }) {
  return (
    <section aria-labelledby="rename-preview-folder-heading">
      <h4 id="rename-preview-folder-heading" className="text-sm font-semibold mb-2">
        Folder
      </h4>
      <DiffRow sign="−" text={from} tone="destructive" />
      <DiffRow sign="+" text={to} tone="success" />
    </section>
  );
}

function FileRenamesSection({ renames }: { renames: Array<{ from: string; to: string }> }) {
  return (
    <section aria-labelledby="rename-preview-files-heading">
      <h4 id="rename-preview-files-heading" className="text-sm font-semibold mb-2">
        Files
      </h4>
      <ul className="space-y-3">
        {renames.map((r, i) => (
          <li key={`${r.from}-${i}`}>
            <DiffRow sign="−" text={r.from} tone="destructive" />
            <DiffRow sign="+" text={r.to} tone="success" />
          </li>
        ))}
      </ul>
    </section>
  );
}

function DiffRow({ sign, text, tone }: { sign: string; text: string; tone: 'destructive' | 'success' }) {
  const toneClass = tone === 'destructive'
    ? 'text-destructive bg-destructive/5'
    : 'text-success bg-success/5';
  return (
    <div className={`flex gap-2 items-start font-mono text-sm rounded px-2 py-1 ${toneClass}`}>
      <span aria-hidden="true" className="font-semibold select-none">{sign}</span>
      <span className="break-all">{text}</span>
    </div>
  );
}

function ConflictBanner({ conflict }: { conflict: RenameConflictError }) {
  return (
    <div
      role="alert"
      className="text-sm bg-destructive/10 text-destructive rounded-lg px-4 py-3 space-y-1"
    >
      <p className="font-semibold">Target folder is already in use.</p>
      <p>
        The target folder belongs to{' '}
        <Link
          to={`/books/${conflict.conflictingBook.id}`}
          className="underline hover:no-underline"
        >
          {conflict.conflictingBook.title}
        </Link>
        . Fix the conflict before renaming.
      </p>
    </div>
  );
}
