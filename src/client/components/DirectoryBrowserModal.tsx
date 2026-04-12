import { useState, useRef, useCallback } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { queryKeys } from '@/lib/queryKeys';
import { getErrorMessage } from '@/lib/error-message.js';
import { useEscapeKey } from '@/hooks/useEscapeKey';
import {
  XIcon,
  FolderIcon,
  FolderOpenIcon,
  ChevronRightIcon,
  LoadingSpinner,
  AlertCircleIcon,
} from '@/components/icons';
import { Modal } from '@/components/Modal';

interface DirectoryBrowserModalProps {
  isOpen: boolean;
  initialPath: string;
  onSelect: (path: string) => void;
  onClose: () => void;
}

function parseBreadcrumbs(path: string): { label: string; path: string }[] {
  const normalized = path.replace(/\\/g, '/');
  const segments = normalized.split('/').filter(Boolean);

  // Root entry
  const root = normalized.startsWith('/') ? '/' : segments[0] + '/';
  const crumbs: { label: string; path: string }[] = [{ label: root, path: root }];

  let accumulated = root;
  const startIndex = normalized.startsWith('/') ? 0 : 1;
  for (let i = startIndex; i < segments.length; i++) {
    accumulated = accumulated.endsWith('/') ? accumulated + segments[i] : accumulated + '/' + segments[i];
    crumbs.push({ label: segments[i], path: accumulated });
  }

  return crumbs;
}

/**
 * Inner modal content — mounted/unmounted by the parent wrapper.
 * This avoids the "setState in useEffect" lint issue by using mount
 * lifecycle to initialize state from initialPath.
 */
function DirectoryBrowserContent({ initialPath, onSelect, onClose }: Omit<DirectoryBrowserModalProps, 'isOpen'>) {
  const modalRef = useRef<HTMLDivElement>(null);
  const [currentPath, setCurrentPath] = useState(initialPath || '/');

  useEscapeKey(true, onClose, modalRef);

  const { data, isLoading, error } = useQuery({
    queryKey: queryKeys.filesystem.browse(currentPath),
    queryFn: () => api.browseDirectory(currentPath),
    retry: false,
  });

  const handleSelect = useCallback(() => {
    onSelect(currentPath);
  }, [currentPath, onSelect]);

  const handleNavigate = useCallback((path: string) => {
    setCurrentPath(path);
  }, []);

  const handleDirClick = useCallback((dirName: string) => {
    const separator = currentPath.endsWith('/') ? '' : '/';
    setCurrentPath(currentPath + separator + dirName);
  }, [currentPath]);

  const breadcrumbs = parseBreadcrumbs(currentPath);

  return (
    <Modal onClose={onClose} closeOnBackdropClick={false} className="w-full max-w-lg flex flex-col max-h-[80vh]">
      <div
        ref={modalRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="directory-browser-modal-title"
        tabIndex={-1}
      >
        {/* Header */}
        <div className="px-6 pt-5 pb-4 flex items-center justify-between shrink-0">
          <div>
            <h2 id="directory-browser-modal-title" className="font-display text-lg font-semibold tracking-tight">Browse Directories</h2>
            <p className="text-xs text-muted-foreground/50 truncate mt-0.5">Select a folder to scan</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-1.5 text-muted-foreground hover:text-foreground rounded-lg transition-colors focus-ring"
            aria-label="Close"
          >
            <XIcon className="w-4 h-4" />
          </button>
        </div>

        <div className="border-t border-white/5" />

        {/* Breadcrumbs */}
        <div className="px-6 py-3 flex items-center gap-1 overflow-x-auto text-sm min-h-[44px]">
          {breadcrumbs.map((crumb, i) => (
            <span key={crumb.path} className="flex items-center gap-1 shrink-0">
              {i > 0 && <ChevronRightIcon className="w-3 h-3 text-muted-foreground/50" />}
              <button
                type="button"
                onClick={() => handleNavigate(crumb.path)}
                className={`px-1.5 py-0.5 rounded transition-colors focus-ring ${
                  i === breadcrumbs.length - 1
                    ? 'text-foreground font-medium'
                    : 'text-muted-foreground hover:text-foreground'
                }`}
              >
                {crumb.label}
              </button>
            </span>
          ))}
        </div>

        <div className="border-t border-white/5" />

        {/* Directory list */}
        <div className="flex-1 overflow-y-auto min-h-[200px] max-h-[400px]">
          {isLoading && (
            <div className="flex items-center justify-center py-12">
              <LoadingSpinner className="w-5 h-5 text-muted-foreground" />
            </div>
          )}

          {error && (
            <div className="flex items-start gap-2.5 mx-6 my-4 px-3 py-2.5 rounded-xl bg-destructive/5 border border-destructive/20">
              <AlertCircleIcon className="w-4 h-4 mt-0.5 shrink-0 text-destructive" />
              <span className="text-sm text-destructive/90">
                {getErrorMessage(error, 'Failed to browse directory')}
              </span>
            </div>
          )}

          {data && !isLoading && data.dirs.length === 0 && (
            <div className="flex flex-col items-center justify-center py-12 text-muted-foreground">
              <FolderOpenIcon className="w-8 h-8 mb-2 text-muted-foreground/40" />
              <p className="text-sm">No subdirectories</p>
            </div>
          )}

          {data && !isLoading && data.dirs.length > 0 && (
            <div className="divide-y divide-white/5">
              {data.dirs.map((dir) => (
                <button
                  type="button"
                  key={dir}
                  onClick={() => handleDirClick(dir)}
                  className="w-full flex items-center gap-3 px-6 py-2.5 text-sm text-left hover:bg-white/5 transition-colors focus-ring group"
                >
                  <FolderIcon className="w-4 h-4 text-primary/60 group-hover:text-primary/90 shrink-0 transition-colors" />
                  <span className="truncate">{dir}</span>
                  <ChevronRightIcon className="w-3 h-3 ml-auto text-muted-foreground/0 group-hover:text-muted-foreground/50 shrink-0 transition-colors" />
                </button>
              ))}
            </div>
          )}
        </div>

        <div className="border-t border-white/5" />

        {/* Footer */}
        <div className="px-6 py-4 flex items-center justify-between shrink-0">
          <p className="text-xs text-muted-foreground/50 truncate mr-4 font-mono" title={currentPath}>
            {currentPath}
          </p>
          <div className="flex items-center gap-3 shrink-0">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 text-sm font-medium glass-card rounded-xl hover:border-primary/30 transition-all focus-ring"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={handleSelect}
              className="px-5 py-2 text-sm font-medium bg-primary text-primary-foreground rounded-xl hover:opacity-90 transition-all focus-ring"
            >
              Select
            </button>
          </div>
        </div>
      </div>
    </Modal>
  );
}

/** Wrapper that mounts/unmounts content to reset state on each open. */
export function DirectoryBrowserModal({ isOpen, ...props }: DirectoryBrowserModalProps) {
  if (!isOpen) return null;
  return <DirectoryBrowserContent {...props} />;
}
