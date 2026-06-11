import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api, RenameConflictError, type BulkRenamePreviewItem } from '@/lib/api';
import { queryKeys } from '@/lib/queryKeys';
import { Modal } from '@/components/Modal';
import { Button } from '@/components/Button';
import { LoadingSpinner } from '@/components/icons';
import { getErrorMessage } from '@/lib/error-message.js';
import {
  PreviewBanner,
  FolderMoveSection,
  FileRenamesSection,
  ConflictBanner,
  DiffRow,
} from '@/components/rename-preview/parts';

interface BulkRenameModalProps {
  isOpen: boolean;
  onClose: () => void;
  onConfirm: () => void;
}

function pluralBooks(n: number): string {
  return n !== 1 ? 'books' : 'book';
}

function Caret({ expanded }: { expanded: boolean }) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={`w-4 h-4 mt-1 shrink-0 text-muted-foreground transition-transform ${expanded ? 'rotate-90' : ''}`}
    >
      <path d="m9 18 6-6-6-6" />
    </svg>
  );
}

/**
 * One mismatched-book row. Collapsed: caret + library-relative folder diff.
 * Expanded: lazily fetches the per-book preview (`GET /books/:id/rename/preview`)
 * and renders its folder + file diff via the shared sections. The per-book query
 * never fires until the row is expanded.
 */
function BulkRenameRow({ item }: { item: BulkRenamePreviewItem }) {
  const [expanded, setExpanded] = useState(false);
  const { data, isLoading, error } = useQuery({
    queryKey: queryKeys.bookRenamePreview(item.bookId),
    queryFn: () => api.getBookRenamePreview(item.bookId),
    enabled: expanded,
    staleTime: 0,
    gcTime: 0,
    refetchOnMount: 'always',
    retry: false,
  });

  const conflict = error instanceof RenameConflictError ? error : null;

  return (
    <li className="border border-border/30 rounded-lg overflow-hidden">
      <button
        type="button"
        aria-expanded={expanded}
        aria-label={item.title}
        onClick={() => setExpanded((e) => !e)}
        className="w-full text-left px-3 py-2 flex items-start gap-2 hover:bg-muted/40 transition-colors focus-ring"
      >
        <Caret expanded={expanded} />
        <div className="flex-1 min-w-0 space-y-1">
          <p className="text-sm font-medium truncate">{item.title}</p>
          <DiffRow sign="−" text={item.from} tone="destructive" />
          <DiffRow sign="+" text={item.to} tone="success" />
        </div>
      </button>

      {expanded && (
        <div className="px-3 pb-3 pt-1 border-t border-border/30 space-y-3">
          {isLoading && (
            <div className="flex items-center py-3 text-muted-foreground">
              <LoadingSpinner className="w-4 h-4" />
              <span className="ml-2 text-sm">Loading preview…</span>
            </div>
          )}

          {conflict && <ConflictBanner conflict={conflict} />}

          {error && !conflict && (
            <p role="alert" className="text-sm text-destructive bg-destructive/10 rounded-lg px-4 py-3">
              {getErrorMessage(error)}
            </p>
          )}

          {data && (
            <>
              {data.folderMove && <FolderMoveSection from={data.folderMove.from} to={data.folderMove.to} />}
              {data.fileRenames.length > 0 ? (
                <FileRenamesSection renames={data.fileRenames} />
              ) : (
                <p className="text-sm text-muted-foreground">No file changes</p>
              )}
            </>
          )}
        </div>
      )}
    </li>
  );
}

/**
 * "Rename All Books" confirmation with a per-book folder-rename preview. Replaces
 * the old count-only confirm (#1406): shows the capped from→to folder list, lets
 * each row expand to its file diff, and defines an explicit empty state when no
 * book is mismatched.
 */
export function BulkRenameModal({ isOpen, onClose, onConfirm }: BulkRenameModalProps) {
  const { data, isLoading, error } = useQuery({
    queryKey: queryKeys.bulkRenamePreview(),
    queryFn: () => api.getBulkRenamePreview(),
    enabled: isOpen,
    staleTime: 0,
    gcTime: 0,
    refetchOnMount: 'always',
    retry: false,
  });

  if (!isOpen) return null;

  const isEmpty = data !== undefined && data.mismatchedTotal === 0;
  const canRename = data !== undefined && !isEmpty;
  const remaining = data ? data.mismatchedTotal - data.items.length : 0;

  return (
    <Modal onClose={onClose} className="w-full max-w-2xl p-6" scrollable>
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="bulk-rename-modal-title"
        tabIndex={-1}
        className="flex flex-col min-h-0"
      >
        <div className="text-center mb-4 shrink-0">
          <h3 id="bulk-rename-modal-title" className="font-display text-xl font-semibold">
            Rename All Books?
          </h3>
        </div>

        <div className="flex-1 min-h-0 overflow-y-auto space-y-4">
          {isLoading && (
            <div className="flex items-center justify-center py-12 text-muted-foreground">
              <LoadingSpinner className="w-5 h-5" />
              <span className="ml-2 text-sm">Building preview…</span>
            </div>
          )}

          {error && (
            <p role="alert" className="text-sm text-destructive bg-destructive/10 rounded-lg px-4 py-3">
              {getErrorMessage(error)}
            </p>
          )}

          {data && (
            <>
              <PreviewBanner
                libraryRoot={data.libraryRoot}
                folderFormat={data.folderFormat}
                fileFormat={data.fileFormat}
              />

              {isEmpty ? (
                <p className="text-sm text-muted-foreground text-center py-4">
                  All {data.alreadyMatching} {pluralBooks(data.alreadyMatching)} already match the current
                  folder format — nothing to rename.
                </p>
              ) : (
                <>
                  <p className="text-sm text-muted-foreground">
                    Rename {data.mismatchedTotal} {pluralBooks(data.mismatchedTotal)} to match the current
                    folder format. {data.alreadyMatching} {pluralBooks(data.alreadyMatching)} already match and
                    will be skipped.
                  </p>

                  <ul className="space-y-2">
                    {data.items.map((item) => (
                      <BulkRenameRow key={item.bookId} item={item} />
                    ))}
                  </ul>

                  {remaining > 0 && (
                    <p className="text-sm text-muted-foreground text-center">…and {remaining} more</p>
                  )}

                  <p className="text-xs text-muted-foreground">
                    Only books whose folder doesn&apos;t match are shown. Changing only the file format
                    isn&apos;t covered here — rename those books individually to apply file-format-only changes.
                  </p>
                </>
              )}
            </>
          )}
        </div>

        <div className="flex flex-col-reverse sm:flex-row gap-3 mt-6 shrink-0">
          <Button variant="secondary" size="md" type="button" onClick={onClose} className="flex-1 text-sm">
            Cancel
          </Button>
          {canRename && (
            <Button
              variant="destructive"
              size="md"
              type="button"
              onClick={() => {
                onClose();
                onConfirm();
              }}
              className="flex-1 text-sm"
            >
              Rename All
            </Button>
          )}
        </div>
      </div>
    </Modal>
  );
}
