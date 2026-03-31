import { ConfirmModal } from '@/components/ConfirmModal';
import { DeleteBookModal } from '@/components/DeleteBookModal';
import { SearchReleasesModal } from '@/components/SearchReleasesModal';
import type { BookWithAuthor } from '@/lib/api';

export function LibraryModals({
  deleteTarget,
  isDeleteOpen,
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
  onDeleteConfirm: (deleteFiles: boolean) => void;
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
      <DeleteBookModal
        isOpen={isDeleteOpen}
        title="Remove from Library"
        message={`Are you sure you want to remove "${deleteTarget?.title}" from your library? This will cancel any active downloads.`}
        fileCount={deleteTarget?.audioFileCount}
        hasPath={!!deleteTarget?.path}
        onConfirm={onDeleteConfirm}
        onCancel={onDeleteCancel}
      />

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
