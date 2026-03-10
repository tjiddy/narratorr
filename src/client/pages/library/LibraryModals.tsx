import { ConfirmModal } from '@/components/ConfirmModal';
import { SearchReleasesModal } from '@/components/SearchReleasesModal';
import type { BookWithAuthor } from '@/lib/api';

export function LibraryModals({
  deleteTarget,
  isDeleteOpen,
  deleteFiles,
  onDeleteFilesChange,
  onDeleteConfirm,
  onDeleteCancel,
  showRemoveMissingModal,
  missingCount,
  onRemoveMissingConfirm,
  onRemoveMissingCancel,
  showSearchAllWantedModal,
  searchAllWantedMessage,
  onSearchAllWantedConfirm,
  onSearchAllWantedCancel,
  searchBook,
  onSearchBookClose,
}: {
  deleteTarget: BookWithAuthor | null;
  isDeleteOpen: boolean;
  deleteFiles: boolean;
  onDeleteFilesChange: (checked: boolean) => void;
  onDeleteConfirm: () => void;
  onDeleteCancel: () => void;
  showRemoveMissingModal: boolean;
  missingCount: number;
  onRemoveMissingConfirm: () => void;
  onRemoveMissingCancel: () => void;
  showSearchAllWantedModal: boolean;
  searchAllWantedMessage: string;
  onSearchAllWantedConfirm: () => void;
  onSearchAllWantedCancel: () => void;
  searchBook: BookWithAuthor | null;
  onSearchBookClose: () => void;
}) {
  return (
    <>
      <ConfirmModal
        isOpen={isDeleteOpen}
        title="Remove from Library"
        message={`Are you sure you want to remove "${deleteTarget?.title}" from your library? This will cancel any active downloads.`}
        confirmLabel="Remove"
        cancelLabel="Cancel"
        onConfirm={onDeleteConfirm}
        onCancel={onDeleteCancel}
      >
        {deleteTarget?.path && (
          <label className="flex items-center gap-2 text-sm text-muted-foreground cursor-pointer select-none">
            <input
              type="checkbox"
              checked={deleteFiles}
              onChange={(e) => onDeleteFilesChange(e.target.checked)}
              className="rounded border-border text-destructive focus:ring-destructive"
            />
            Delete files from disk
          </label>
        )}
      </ConfirmModal>

      <ConfirmModal
        isOpen={showRemoveMissingModal}
        title="Remove Missing Books"
        message={`Remove ${missingCount} missing book${missingCount !== 1 ? 's' : ''} from library?`}
        confirmLabel="Remove"
        cancelLabel="Cancel"
        onConfirm={onRemoveMissingConfirm}
        onCancel={onRemoveMissingCancel}
      />

      <ConfirmModal
        isOpen={showSearchAllWantedModal}
        title="Search All Wanted"
        message={searchAllWantedMessage}
        confirmLabel="Search"
        cancelLabel="Cancel"
        onConfirm={onSearchAllWantedConfirm}
        onCancel={onSearchAllWantedCancel}
      />

      {searchBook && (
        <SearchReleasesModal
          isOpen={searchBook !== null}
          book={searchBook}
          onClose={onSearchBookClose}
        />
      )}
    </>
  );
}
