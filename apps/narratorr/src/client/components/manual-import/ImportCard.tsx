import { type DiscoveredBook, type Confidence, type MatchResult, formatBytes } from '@/lib/api';
import type { BookEditState } from './BookEditModal.js';
import {
  CheckIcon,
  CheckCircleIcon,
  AlertCircleIcon,
  XCircleIcon,
  PencilIcon,
  HeadphonesIcon,
  LoadingSpinner,
} from '@/components/icons';

export interface ImportRow {
  book: DiscoveredBook;
  selected: boolean;
  edited: BookEditState;
  matchResult?: MatchResult;
}

interface ImportCardProps {
  row: ImportRow;
  onToggle: () => void;
  onEdit: () => void;
}

function ConfidenceBadge({ confidence }: { confidence?: Confidence }) {
  if (!confidence) {
    return (
      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-medium bg-muted/30 text-muted-foreground/50">
        <LoadingSpinner className="w-3 h-3" />
        Matching
      </span>
    );
  }

  const styles = {
    high: 'bg-emerald-500/15 text-emerald-400 ring-emerald-500/20',
    medium: 'bg-amber-500/15 text-amber-400 ring-amber-500/20',
    none: 'bg-red-500/15 text-red-400 ring-red-500/20',
  };

  const icons = {
    high: <CheckCircleIcon className="w-3 h-3" />,
    medium: <AlertCircleIcon className="w-3 h-3" />,
    none: <XCircleIcon className="w-3 h-3" />,
  };

  const labels = {
    high: 'Matched',
    medium: 'Review',
    none: 'No Match',
  };

  return (
    <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-medium ring-1 ${styles[confidence]}`}>
      {icons[confidence]}
      {labels[confidence]}
    </span>
  );
}

// eslint-disable-next-line complexity -- confidence scoring display with conditional styles and layouts
export function ImportCard({ row, onToggle, onEdit }: ImportCardProps) {
  const confidence = row.matchResult?.confidence;
  const showPencilAlways = !confidence || confidence === 'medium' || confidence === 'none';
  const displayTitle = row.edited.title;
  const displayAuthor = row.edited.author || row.book.parsedAuthor || '';
  const displayNarrator = row.matchResult?.bestMatch?.narrators?.join(', ');
  // Show last 3 path segments for context (e.g. "Author/Series/Book Folder")
  const pathParts = row.book.path.split(/[\\/]/).filter(Boolean);
  const shortPath = pathParts.slice(-3).join('/') || row.book.path;

  // Left border: amber for no-match, matches LibraryPage's status border pattern
  const borderClass = confidence === 'none'
    ? 'border-l-[3px] border-l-amber-500'
    : confidence === 'medium'
      ? 'border-l-[3px] border-l-amber-500/40'
      : '';

  // Grey out rows that are still matching
  const matchingClass = !confidence ? 'opacity-50' : '';

  return (
    <div
      className={`group flex items-center gap-3 px-4 py-3 transition-all duration-300 ${borderClass} ${matchingClass} ${
        row.selected ? 'bg-primary/5' : 'hover:bg-muted/20'
      }`}
    >
      {/* Checkbox */}
      <button
        onClick={onToggle}
        className={`w-4 h-4 shrink-0 rounded border transition-all flex items-center justify-center ${
          row.selected
            ? 'bg-primary border-primary text-primary-foreground'
            : 'border-border/60 hover:border-primary/50'
        }`}
        aria-label={row.selected ? 'Deselect' : 'Select'}
      >
        {row.selected && <CheckIcon className="w-3 h-3" />}
      </button>

      {/* Title + filepath */}
      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium truncate">{displayTitle}</p>
        <p className="text-xs text-muted-foreground/50 truncate" title={row.book.path}>
          {shortPath}
        </p>
      </div>

      {/* Author + narrator/size */}
      <div className="hidden sm:block w-48 shrink-0 text-right">
        <p className="text-sm text-muted-foreground truncate">
          {displayAuthor || <span className="italic text-muted-foreground/40">Unknown</span>}
        </p>
        <p className="text-xs text-muted-foreground/50 truncate">
          {displayNarrator
            ? <span className="inline-flex items-center gap-1"><HeadphonesIcon className="w-2.5 h-2.5 shrink-0" />{displayNarrator} &middot; {formatBytes(row.book.totalSize)}</span>
            : <>{row.book.fileCount} file{row.book.fileCount !== 1 ? 's' : ''} &middot; {formatBytes(row.book.totalSize)}</>
          }
        </p>
      </div>

      {/* Confidence badge */}
      <div className="w-24 shrink-0 flex justify-center">
        <ConfidenceBadge confidence={confidence} />
      </div>

      {/* Edit button */}
      <button
        onClick={onEdit}
        className={`p-1.5 rounded-lg transition-colors focus-ring ${
          showPencilAlways
            ? 'text-muted-foreground hover:text-primary'
            : 'text-transparent group-hover:text-muted-foreground hover:!text-primary'
        }`}
        aria-label="Edit metadata"
      >
        <PencilIcon className="w-3.5 h-3.5" />
      </button>
    </div>
  );
}
