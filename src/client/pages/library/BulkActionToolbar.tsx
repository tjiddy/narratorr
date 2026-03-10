import { useState, useEffect, useRef } from 'react';
import { TrashIcon, SearchIcon, ChevronDownIcon } from '@/components/icons';
import { ConfirmModal } from '@/components/ConfirmModal';

export function BulkActionToolbar({
  selectedCount,
  onDelete,
  isDeleting,
  onSearch,
  isSearching,
  onSetStatus,
  isSettingStatus,
  hasPath,
}: {
  selectedCount: number;
  onDelete: (deleteFiles: boolean) => void;
  isDeleting: boolean;
  onSearch: () => void;
  isSearching: boolean;
  onSetStatus: (status: string, label: string) => void;
  isSettingStatus: boolean;
  hasPath: boolean;
}) {
  const [showDeleteModal, setShowDeleteModal] = useState(false);
  const [deleteFiles, setDeleteFiles] = useState(false);
  const [showStatusMenu, setShowStatusMenu] = useState(false);
  const statusMenuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!showStatusMenu) return;
    function handleClick(e: MouseEvent) {
      if (statusMenuRef.current && !statusMenuRef.current.contains(e.target as Node)) {
        setShowStatusMenu(false);
      }
    }
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [showStatusMenu]);

  if (selectedCount === 0) return null;

  return (
    <>
      <div className="flex items-center gap-3 px-4 py-2.5 glass-card rounded-xl animate-fade-in">
        <span className="text-sm font-medium text-foreground">
          {selectedCount} selected
        </span>
        <div className="h-4 w-px bg-border" />
        <button
          type="button"
          onClick={() => setShowDeleteModal(true)}
          disabled={isDeleting}
          className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-destructive bg-destructive/10 rounded-lg hover:bg-destructive/20 disabled:opacity-50 transition-colors focus-ring"
        >
          <TrashIcon className="w-3.5 h-3.5" />
          Delete
        </button>
        <button
          type="button"
          onClick={onSearch}
          disabled={isSearching}
          className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-primary bg-primary/10 rounded-lg hover:bg-primary/20 disabled:opacity-50 transition-colors focus-ring"
        >
          <SearchIcon className="w-3.5 h-3.5" />
          {isSearching ? 'Searching...' : 'Search'}
        </button>
        <div className="relative" ref={statusMenuRef}>
          <button
            type="button"
            onClick={() => setShowStatusMenu(!showStatusMenu)}
            disabled={isSettingStatus}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-muted-foreground bg-muted/50 rounded-lg hover:bg-muted/80 disabled:opacity-50 transition-colors focus-ring"
          >
            Set Status
            <ChevronDownIcon className="w-3 h-3" />
          </button>
          {showStatusMenu && (
            <div className="absolute top-full left-0 mt-1 w-32 glass-card rounded-lg shadow-lg border border-border/50 overflow-hidden z-50">
              <button
                type="button"
                onClick={() => { onSetStatus('wanted', 'Wanted'); setShowStatusMenu(false); }}
                className="w-full text-left px-3 py-2 text-xs font-medium hover:bg-muted/50 transition-colors"
              >
                Wanted
              </button>
              <button
                type="button"
                onClick={() => { onSetStatus('imported', 'Owned'); setShowStatusMenu(false); }}
                className="w-full text-left px-3 py-2 text-xs font-medium hover:bg-muted/50 transition-colors"
              >
                Owned
              </button>
            </div>
          )}
        </div>
      </div>

      <ConfirmModal
        isOpen={showDeleteModal}
        title="Delete Selected Books"
        message={`Delete ${selectedCount} selected book${selectedCount !== 1 ? 's' : ''}? This will cancel any active downloads.`}
        confirmLabel="Delete"
        cancelLabel="Cancel"
        onConfirm={() => { setShowDeleteModal(false); onDelete(deleteFiles); setDeleteFiles(false); }}
        onCancel={() => { setShowDeleteModal(false); setDeleteFiles(false); }}
      >
        {hasPath && (
          <label className="flex items-center gap-2 text-sm text-muted-foreground cursor-pointer select-none">
            <input
              type="checkbox"
              checked={deleteFiles}
              onChange={(e) => setDeleteFiles(e.target.checked)}
              className="rounded border-border text-destructive focus:ring-destructive"
            />
            Delete files from disk
          </label>
        )}
      </ConfirmModal>
    </>
  );
}
