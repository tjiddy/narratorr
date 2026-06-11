import { useQuery } from '@tanstack/react-query';
import { api, RenameConflictError, type RenamePreviewResult } from '@/lib/api';
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
} from '@/components/rename-preview/parts';

interface RenamePreviewModalProps {
  bookId: number;
  isOpen: boolean;
  onClose: () => void;
  onConfirm: () => void;
}

export function RenamePreviewModal({ bookId, isOpen, onClose, onConfirm }: RenamePreviewModalProps) {
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
      <PreviewBanner
        libraryRoot={plan.libraryRoot}
        folderFormat={plan.folderFormat}
        fileFormat={plan.fileFormat}
      />
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
