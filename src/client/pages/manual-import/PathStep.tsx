import { PathInput } from '@/components/PathInput';
import {
  AlertCircleIcon,
  LoadingSpinner,
  HeartIcon,
  HeartFillIcon,
  XIcon,
} from '@/components/icons';
import type { FolderEntry } from './useFolderHistory.js';

interface FolderHistoryApi {
  favorites: FolderEntry[];
  recents: FolderEntry[];
  promoteToFavorite: (path: string) => void;
  demoteToRecent: (path: string) => void;
  removeRecent: (path: string) => void;
  removeFavorite: (path: string) => void;
}

interface PathStepProps {
  scanPath: string;
  setScanPath: (path: string) => void;
  setScanError: (error: string | null) => void;
  scanError: string | null;
  handleScan: () => void;
  isPending: boolean;
  libraryPath: string;
  folderHistory: FolderHistoryApi;
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

export function PathStep({
  scanPath,
  setScanPath,
  setScanError,
  scanError,
  handleScan,
  isPending,
  libraryPath,
  folderHistory,
}: PathStepProps) {
  const { favorites, recents, promoteToFavorite, demoteToRecent, removeRecent, removeFavorite } = folderHistory;

  function handleFolderClick(path: string) {
    setScanPath(path);
    setScanError(null);
  }

  return (
    <div className="max-w-xl space-y-4 animate-fade-in-up stagger-1">
      {/* Favorite Folders */}
      <div className="space-y-1.5">
        <p className="text-xs font-medium text-muted-foreground/70 uppercase tracking-wide">Favorite Folders</p>
        {favorites.length === 0 ? (
          <p className="text-xs text-muted-foreground/40 px-1">No favorite folders yet</p>
        ) : (
          <div className="space-y-1">
            {favorites.map((entry) => (
              <div
                key={entry.path}
                className="flex items-center gap-2 px-3 py-2 rounded-lg bg-white/3 border border-white/5 hover:border-primary/20 transition-colors group"
              >
                <button
                  type="button"
                  onClick={() => handleFolderClick(entry.path)}
                  aria-label={entry.path}
                  className="flex-1 text-left text-sm truncate text-foreground/80 hover:text-foreground transition-colors focus-ring rounded"
                >
                  {entry.path}
                </button>
                <span className="text-xs text-muted-foreground/50 shrink-0 hidden group-hover:block">
                  {formatDate(entry.lastUsedAt)}
                </span>
                <button
                  type="button"
                  onClick={() => demoteToRecent(entry.path)}
                  aria-label={`Unfavorite ${entry.path}`}
                  className="p-0.5 text-primary/70 hover:text-primary transition-colors focus-ring rounded shrink-0"
                >
                  <HeartFillIcon className="w-3.5 h-3.5" />
                </button>
                <button
                  type="button"
                  onClick={() => removeFavorite(entry.path)}
                  aria-label={`Remove favorite ${entry.path}`}
                  className="p-0.5 text-muted-foreground/40 hover:text-muted-foreground transition-colors focus-ring rounded shrink-0"
                >
                  <XIcon className="w-3.5 h-3.5" />
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Recent Folders */}
      <div className="space-y-1.5">
        <p className="text-xs font-medium text-muted-foreground/70 uppercase tracking-wide">Recent Folders</p>
        {recents.length === 0 ? (
          <p className="text-xs text-muted-foreground/40 px-1">No recent folders yet</p>
        ) : (
          <div className="space-y-1">
            {recents.map((entry) => (
              <div
                key={entry.path}
                className="flex items-center gap-2 px-3 py-2 rounded-lg bg-white/3 border border-white/5 hover:border-primary/20 transition-colors group"
              >
                <button
                  type="button"
                  onClick={() => handleFolderClick(entry.path)}
                  aria-label={entry.path}
                  className="flex-1 text-left text-sm truncate text-foreground/80 hover:text-foreground transition-colors focus-ring rounded"
                >
                  {entry.path}
                </button>
                <span className="text-xs text-muted-foreground/50 shrink-0 hidden group-hover:block">
                  {formatDate(entry.lastUsedAt)}
                </span>
                <button
                  type="button"
                  onClick={() => promoteToFavorite(entry.path)}
                  aria-label={`Favorite ${entry.path}`}
                  className="p-0.5 text-muted-foreground/40 hover:text-primary transition-colors focus-ring rounded shrink-0"
                >
                  <HeartIcon className="w-3.5 h-3.5" />
                </button>
                <button
                  type="button"
                  onClick={() => removeRecent(entry.path)}
                  aria-label={`Remove recent ${entry.path}`}
                  className="p-0.5 text-muted-foreground/40 hover:text-muted-foreground transition-colors focus-ring rounded shrink-0"
                >
                  <XIcon className="w-3.5 h-3.5" />
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Path input */}
      <PathInput
        value={scanPath}
        onChange={(path) => { setScanPath(path); setScanError(null); }}
        placeholder="/path/to/audiobooks"
        fallbackBrowsePath={libraryPath || '/'}
        onKeyDown={(e) => e.key === 'Enter' && handleScan()}
        autoFocus
      />

      {scanError && (
        <div className="flex items-start gap-2.5 px-3 py-2.5 rounded-xl bg-amber-500/5 border border-amber-500/20">
          <AlertCircleIcon className="w-4 h-4 mt-0.5 shrink-0 text-amber-400" />
          <span className="text-sm text-amber-300/90">{scanError}</span>
        </div>
      )}

      <div className="flex items-center justify-between">
        <p className="text-xs text-muted-foreground/70">
          Point to a folder containing audiobook subfolders (Author/Title, etc.)
        </p>
        <button
          type="button"
          onClick={handleScan}
          disabled={!scanPath.trim() || isPending}
          className="flex items-center gap-2 px-5 py-2.5 text-sm font-medium bg-primary text-primary-foreground rounded-xl hover:opacity-90 transition-all disabled:opacity-40 disabled:cursor-not-allowed focus-ring"
        >
          {isPending && <LoadingSpinner className="w-3.5 h-3.5" />}
          {isPending ? 'Scanning...' : 'Scan'}
        </button>
      </div>
    </div>
  );
}
