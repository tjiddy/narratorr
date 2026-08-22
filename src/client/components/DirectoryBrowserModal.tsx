import { useState, useCallback, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api, type BrowseResult } from '@/lib/api';
import { queryKeys } from '@/lib/queryKeys';
import { getErrorMessage } from '@/lib/error-message.js';
import {
  XIcon,
  FolderIcon,
  FolderOpenIcon,
  HeadphonesIcon,
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
  /** #2435 AC20: also list supported audio files and let one be chosen. Existing callers omit it
   * and keep today's directory-only behaviour with no prop change. */
  selectableFiles?: boolean | undefined;
  /** #2478: hold the confirm button until the user clicks a file or the "use this folder"
   * affordance. Omitted, the modal keeps submitting the current directory unprompted. */
  requireExplicitSelection?: boolean | undefined;
  title?: string | undefined;
  subtitle?: string | undefined;
  /** Rendered beside the path in the footer; used for the copy/move choice. */
  footerExtra?: ReactNode | undefined;
  selectLabel?: string | undefined;
  selectDisabled?: boolean | undefined;
}

function parseBreadcrumbs(path: string): { label: string; path: string }[] {
  const normalized = path.replace(/\\/g, '/');
  const segments = normalized.split('/').filter(Boolean);

  const root = normalized.startsWith('/') ? '/' : segments[0] + '/';
  const crumbs: { label: string; path: string }[] = [{ label: root, path: root }];

  let accumulated = root;
  const startIndex = normalized.startsWith('/') ? 0 : 1;
  for (let i = startIndex; i < segments.length; i++) {
    accumulated = accumulated.endsWith('/') ? accumulated + segments[i] : accumulated + '/' + segments[i];
    crumbs.push({ label: segments[i]!, path: accumulated });
  }

  return crumbs;
}

/** Opt-in audio entries; selecting one narrows the chosen path from the folder to that file. */
function AudioFileList({ files, selectedFile, onFileClick }: {
  files: string[];
  selectedFile: string | null;
  onFileClick: (file: string) => void;
}) {
  return (
    <div className="divide-y divide-white/5 border-t border-white/5">
      {files.map((file) => (
        <button
          type="button"
          key={file}
          aria-pressed={selectedFile === file}
          onClick={() => onFileClick(file)}
          className={`w-full flex items-center gap-3 px-6 py-2.5 text-sm text-left transition-colors focus-ring group ${
            selectedFile === file ? 'bg-primary/10 text-foreground' : 'hover:bg-white/5'
          }`}
        >
          <HeadphonesIcon className="w-4 h-4 text-primary/60 shrink-0" />
          <span className="truncate">{file}</span>
        </button>
      ))}
    </div>
  );
}

interface BrowserEntriesProps {
  data: BrowseResult | undefined;
  isLoading: boolean;
  error: unknown;
  selectedFile: string | null;
  onDirClick: (dir: string) => void;
  onFileClick: (file: string) => void;
}

/** The scrollable listing: loading, error, empty, directories, and (when opted in) audio files. */
/** Directory entries; navigating into one clears any pending file selection. */
function DirList({ dirs, onDirClick }: { dirs: string[]; onDirClick: (dir: string) => void }) {
  return (
    <div className="divide-y divide-white/5">
      {dirs.map((dir) => (
        <button
          type="button"
          key={dir}
          onClick={() => onDirClick(dir)}
          className="w-full flex items-center gap-3 px-6 py-2.5 text-sm text-left hover:bg-white/5 transition-colors focus-ring group"
        >
          <FolderIcon className="w-4 h-4 text-primary/60 group-hover:text-primary/90 shrink-0 transition-colors" />
          <span className="truncate">{dir}</span>
          <ChevronRightIcon className="w-3 h-3 ml-auto text-muted-foreground/0 group-hover:text-muted-foreground/50 shrink-0 transition-colors" />
        </button>
      ))}
    </div>
  );
}

function BrowserEntries({ data, isLoading, error, selectedFile, onDirClick, onFileClick }: BrowserEntriesProps) {
  const dirs = data?.dirs ?? [];
  const files = data?.files ?? [];
  const settled = data !== undefined && !isLoading;
  return (
    <div className="flex-1 overflow-y-auto min-h-[200px] max-h-[400px]">
      {isLoading && (
        <div className="flex items-center justify-center py-12">
          <LoadingSpinner className="w-5 h-5 text-muted-foreground" />
        </div>
      )}

      {error != null && (
        <div className="flex items-start gap-2.5 mx-6 my-4 px-3 py-2.5 rounded-xl bg-destructive/5 border border-destructive/20">
          <AlertCircleIcon className="w-4 h-4 mt-0.5 shrink-0 text-destructive" />
          <span className="text-sm text-destructive/90">{getErrorMessage(error)}</span>
        </div>
      )}

      {settled && dirs.length === 0 && files.length === 0 && (
        <div className="flex flex-col items-center justify-center py-12 text-muted-foreground">
          <FolderOpenIcon className="w-8 h-8 mb-2 text-muted-foreground/40" />
          <p className="text-sm">No subdirectories</p>
        </div>
      )}

      {settled && dirs.length > 0 && <DirList dirs={dirs} onDirClick={onDirClick} />}

      {settled && files.length > 0 && (
        <AudioFileList files={files} selectedFile={selectedFile} onFileClick={onFileClick} />
      )}
    </div>
  );
}

/** The second way to answer "which thing do you mean" — the first is clicking an audio file. */
function UseThisFolderButton({ chosen, onToggle }: { chosen: boolean; onToggle: () => void }) {
  return (
    <button
      type="button"
      aria-pressed={chosen}
      onClick={onToggle}
      className={`px-2.5 py-1 text-xs font-medium rounded-lg transition-colors focus-ring ${
        chosen ? 'bg-primary/15 text-primary' : 'text-muted-foreground hover:text-foreground'
      }`}
    >
      Use this folder
    </button>
  );
}

// Mounting this inner component resets initialPath state without a syncing effect.
function DirectoryBrowserContent({ initialPath, onSelect, onClose, selectableFiles, requireExplicitSelection, title, subtitle, footerExtra, selectLabel, selectDisabled }: DirectoryBrowserModalProps) {
  const [currentPath, setCurrentPath] = useState(initialPath || '/');
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [folderChosen, setFolderChosen] = useState(false);

  const capability = selectableFiles ? 'audio' : 'legacy';
  const { data, isLoading, error } = useQuery({
    // The capability rides in the key as well as the request: the two shapes must not share a
    // cache entry for the same path.
    queryKey: queryKeys.filesystem.browse(currentPath, capability),
    queryFn: () => api.browseDirectory(currentPath, capability),
    retry: false,
  });

  const joinPath = useCallback(
    (name: string) => (currentPath.endsWith('/') ? currentPath : currentPath + '/') + name,
    [currentPath],
  );

  const handleSelect = useCallback(() => {
    onSelect(selectedFile ? joinPath(selectedFile) : currentPath);
  }, [currentPath, joinPath, onSelect, selectedFile]);

  // Navigating away invalidates BOTH answers: the file is no longer listed, and "this folder" now
  // names a different one.
  const handleNavigate = useCallback((path: string) => {
    setSelectedFile(null);
    setFolderChosen(false);
    setCurrentPath(path);
  }, []);

  const handleDirClick = useCallback((dirName: string) => {
    setSelectedFile(null);
    setFolderChosen(false);
    setCurrentPath(joinPath(dirName));
  }, [joinPath]);

  // The two answers are mutually exclusive, so the footer preview and the submitted path agree.
  const handleFileClick = useCallback((file: string) => {
    setFolderChosen(false);
    setSelectedFile((current) => (current === file ? null : file));
  }, []);

  const breadcrumbs = parseBreadcrumbs(currentPath);
  const nothingChosen = requireExplicitSelection === true && selectedFile === null && !folderChosen;

  return (
    <Modal onClose={onClose} className="w-full max-w-lg flex flex-col max-h-[80vh]">
      {/* min-h-0 lets the directory list shrink inside Modal's capped flex column. */}
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="directory-browser-modal-title"
        tabIndex={-1}
        className="flex flex-col min-h-0 flex-1"
      >
        <div className="px-6 pt-5 pb-4 flex items-center justify-between shrink-0">
          <div>
            <h2 id="directory-browser-modal-title" className="font-display text-lg font-semibold tracking-tight">{title ?? 'Browse Directories'}</h2>
            <p className="text-xs text-muted-foreground/50 truncate mt-0.5">{subtitle ?? 'Select a folder to scan'}</p>
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

        <BrowserEntries
          data={data}
          isLoading={isLoading}
          error={error}
          selectedFile={selectedFile}
          onDirClick={handleDirClick}
          onFileClick={handleFileClick}
        />

        <div className="border-t border-white/5" />

        <div className="px-6 py-4 flex items-center justify-between shrink-0">
          <div className="min-w-0 mr-4">
            {footerExtra}
            {requireExplicitSelection === true && (
              <div className="mb-1.5">
                <UseThisFolderButton
                  chosen={folderChosen}
                  onToggle={() => { setSelectedFile(null); setFolderChosen((chosen) => !chosen); }}
                />
              </div>
            )}
            <p className="text-xs text-muted-foreground/50 truncate font-mono" title={selectedFile ? joinPath(selectedFile) : currentPath}>
              {selectedFile ? joinPath(selectedFile) : currentPath}
            </p>
          </div>
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
              disabled={selectDisabled === true || nothingChosen}
              className="px-5 py-2 text-sm font-medium bg-primary text-primary-foreground rounded-xl hover:opacity-90 transition-all focus-ring disabled:opacity-50 disabled:pointer-events-none"
            >
              {selectLabel ?? 'Select'}
            </button>
          </div>
        </div>
      </div>
    </Modal>
  );
}

export function DirectoryBrowserModal({ isOpen, ...props }: DirectoryBrowserModalProps) {
  if (!isOpen) return null;
  return <DirectoryBrowserContent isOpen={isOpen} {...props} />;
}
