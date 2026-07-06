import { type Confidence, formatBytes } from '@/lib/api';
import type { ImportRow } from './types.js';
import {
  CheckIcon,
  CheckCircleIcon,
  AlertCircleIcon,
  XCircleIcon,
  PencilIcon,
  HeadphonesIcon,
  LoadingSpinner,
} from '@/components/icons';
import { Badge } from '@/components/Badge';
import { AudioPreview } from '@/pages/book/AudioPreview';
export type { ImportRow } from './types.js';

interface ImportCardProps {
  row: ImportRow;
  onToggle: () => void;
  onEdit: () => void;
  /** When true, path-duplicates suppress checkbox+edit; slug-duplicates suppress checkbox but show edit */
  lockDuplicates?: boolean | undefined;
  /** Pre-computed relative path to display instead of the auto-shortened absolute path */
  relativePath?: string | undefined;
}

const confidenceVariant = {
  high: 'success',
  medium: 'warning',
  none: 'danger',
} as const;

const confidenceIcon = {
  high: CheckCircleIcon,
  medium: AlertCircleIcon,
  none: XCircleIcon,
} as const;

const confidenceLabel = {
  high: 'Matched',
  medium: 'Review',
  none: 'No Match',
} as const;

/**
 * Three-way import-review badge ladder (#1712 §3c). Precedence: the recording
 * verdict (set by the match job for library hits) wins; a scan-time DB duplicate
 * (path/decisive-ASIN) carries no verdict and falls back to the duplicate flags.
 *
 * `reviewReason` is deliberately NOT a rung — it is a separate display-only
 * absorbed-content warning (#1031) rendered as its own tooltip indicator, and an
 * ordinary new book can carry it. Only `recordingVerdict:'review'` lights the
 * "Possible duplicate (review)" badge.
 */
function ownershipBadge(book: ImportRow['book']): { label: string; variant: 'muted' | 'warning' } | null {
  switch (book.recordingVerdict) {
    case 'same-recording': return { label: 'Already owned', variant: 'muted' };
    case 'different-recording': return { label: 'New version of an owned title', variant: 'muted' };
    case 'review': return { label: 'Possible duplicate (review)', variant: 'warning' };
  }
  // Scan-time DB duplicates bypass the match-job helper, so they have no verdict.
  if (book.isDuplicate && (book.duplicateReason === 'path' || book.duplicateReason === 'slug')) {
    return { label: 'Already owned', variant: 'muted' };
  }
  return null;
}

function ConfidenceBadge({ confidence, reason }: { confidence?: Confidence | undefined; reason?: string | undefined }) {
  if (!confidence) {
    return (
      <Badge variant="muted" icon={LoadingSpinner}>
        Matching
      </Badge>
    );
  }

  const title = confidence === 'medium' && reason ? reason : undefined;

  return (
    <Badge variant={confidenceVariant[confidence]} icon={confidenceIcon[confidence]} title={title}>
      {confidenceLabel[confidence]}
    </Badge>
  );
}

// eslint-disable-next-line complexity -- confidence scoring display with conditional styles and layouts
export function ImportCard({ row, onToggle, onEdit, lockDuplicates, relativePath }: ImportCardProps) {
  const isDuplicate = row.book.isDuplicate;
  const confidence = row.matchResult?.confidence;
  const showPencilAlways = !confidence || confidence === 'medium' || confidence === 'none';
  const displayTitle = row.edited.title;
  const displayAuthor = row.edited.author || row.book.parsedAuthor || '';
  // Prefer the top-level edited narrator (where the Edit Book modal saves the user's
  // edit, and where matched rows are seeded) over metadata.narrators — mirroring the
  // import-confirm + server narrator precedence so the row shows what will be imported (#1660).
  const displayNarrator = row.edited.narrators?.length
    ? row.edited.narrators.join(', ')
    : row.edited.metadata?.narrators?.join(', ');
  // Show pre-computed relative path if provided, otherwise last 3 path segments
  const pathParts = row.book.path.split(/[\\/]/).filter(Boolean);
  const shortPath = relativePath ?? pathParts.slice(-3).join('/') ?? row.book.path;

  // When lockDuplicates=true: path-duplicates are fully locked; slug-duplicates show edit but no checkbox.
  // Within-scan duplicates are always selectable/editable (they're not in the DB yet).
  const isWithinScanDuplicate = isDuplicate && row.book.duplicateReason === 'within-scan';
  const isPathDuplicate = lockDuplicates && isDuplicate && row.book.duplicateReason === 'path';
  const isSlugDuplicate = lockDuplicates && isDuplicate && row.book.duplicateReason === 'slug';
  const showCheckbox = !isPathDuplicate && !isSlugDuplicate;
  const showEditButton = !isDuplicate || isSlugDuplicate || isWithinScanDuplicate;
  const ownership = ownershipBadge(row.book);

  // Left border: amber for no-match, matches LibraryPage's status border pattern
  const borderClass = confidence === 'none'
    ? 'border-l-[3px] border-l-amber-500'
    : confidence === 'medium'
      ? 'border-l-[3px] border-l-amber-500/40'
      : '';

  // Mute unselected duplicate rows; grey out rows that are still matching.
  // Selected duplicates (force-import opt-in) are undimmed entirely.
  const dimClass = isDuplicate
    ? (row.selected ? '' : 'opacity-60')
    : (!confidence ? 'opacity-50' : '');

  return (
    <div
      className={`group flex items-center gap-3 px-4 py-3 transition-all duration-300 ${borderClass} ${dimClass} ${
        row.selected ? 'bg-primary/5' : 'hover:bg-muted/20'
      }`}
    >
      {/* Checkbox */}
      {showCheckbox && (
        <button
          type="button"
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
      )}

      {/* Title + filepath */}
      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium truncate">{displayTitle}</p>
        <p className="text-xs text-muted-foreground/50 truncate" title={row.book.path}>
          {shortPath}
        </p>
      </div>

      {/* Author + narrator/size */}
      <div className="hidden sm:block w-64 shrink-0 text-right">
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

      {/* Badge: three-way recording-review ladder (#1712) for owned/new-version/review,
          "Duplicate in scan" for within-scan, confidence badge for a genuinely new book. */}
      <div className="w-32 shrink-0 flex justify-center">
        {isWithinScanDuplicate ? (
          <Badge variant="muted">Duplicate in scan</Badge>
        ) : ownership ? (
          <Badge variant={ownership.variant}>{ownership.label}</Badge>
        ) : (
          <ConfidenceBadge confidence={confidence} reason={row.matchResult?.reason} />
        )}
      </div>

      {/* Discovery review-flag indicator — independent of confidence so high-match
          rows still surface absorbed-bonus warnings before import (#1031). */}
      {row.book.reviewReason && (
        <span
          title={row.book.reviewReason}
          tabIndex={0}
          aria-label={row.book.reviewReason}
          data-testid="review-reason-indicator"
          className="shrink-0 text-amber-500/80 hover:text-amber-500 focus-ring rounded"
        >
          <AlertCircleIcon className="w-4 h-4" />
        </span>
      )}

      {/* Audio preview — always visible when previewUrl is present */}
      {row.book.previewUrl && (
        <AudioPreview
          source={{ kind: 'url', previewUrl: row.book.previewUrl, enabled: true }}
          size="compact"
        />
      )}

      {/* Edit button — hidden for path-locked duplicate rows */}
      {showEditButton && (
        <button
          type="button"
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
      )}
    </div>
  );
}
