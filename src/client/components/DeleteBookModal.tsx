import { useState } from 'react';
import { ConfirmModal } from './ConfirmModal';

function formatFileCountLabel(fileCount: number | null | undefined): string {
  if (fileCount && fileCount > 0) {
    return `Also delete ${fileCount} file${fileCount !== 1 ? 's' : ''} from disk`;
  }
  return 'Delete files from disk';
}

interface DeleteBookModalProps {
  isOpen: boolean;
  title: string;
  message: string;
  fileCount?: number | null;
  hasPath: boolean;
  onConfirm: (deleteFiles: boolean) => void;
  onCancel: () => void;
}

export function DeleteBookModal({
  isOpen,
  title,
  message,
  fileCount,
  hasPath,
  onConfirm,
  onCancel,
}: DeleteBookModalProps) {
  const [deleteFiles, setDeleteFiles] = useState(false);

  const handleConfirm = () => {
    onConfirm(deleteFiles);
    setDeleteFiles(false);
  };

  const handleCancel = () => {
    onCancel();
    setDeleteFiles(false);
  };

  return (
    <ConfirmModal
      isOpen={isOpen}
      title={title}
      message={message}
      confirmLabel="Remove"
      cancelLabel="Cancel"
      onConfirm={handleConfirm}
      onCancel={handleCancel}
    >
      {hasPath && (
        <label className="flex items-center gap-2 text-sm text-muted-foreground cursor-pointer select-none">
          <input
            type="checkbox"
            checked={deleteFiles}
            onChange={(e) => setDeleteFiles(e.target.checked)}
            className="rounded border-border text-destructive focus:ring-destructive"
          />
          {formatFileCountLabel(fileCount)}
        </label>
      )}
    </ConfirmModal>
  );
}
