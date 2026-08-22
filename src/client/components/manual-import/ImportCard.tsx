import { type Confidence, formatBytes } from '@/lib/api';
import type { ImportCardAnnotation, ImportRow } from './types.js';
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
import { pickPrimarySeries } from '@shared/pick-primary-series.js';
export type { ImportRow } from './types.js';

interface ImportCardProps {
  row: ImportRow;
  /** Omitted for read-only rows, which then render no checkbox at all. */
  onToggle?: (() => void) | undefined;
  onEdit: () => void;
  /** Locks path duplicates completely; slug duplicates remain editable. */
  lockDuplicates?: boolean | undefined;
  relativePath?: string | undefined;
  /** Replaces a pending Matching spinner with Paused; ownership badges still win. */
  paused?: boolean | undefined;
  /** Caller-owned display override; its badge outranks every badge this card computes itself. */
  annotation?: ImportCardAnnotation | undefined;
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
 * Recording verdicts win; scan-time duplicates fall back to duplicate flags.
 * `reviewReason` is a separate warning, never an ownership-badge rung.
 */
function ownershipBadge(book: ImportRow['book']): { label: string; variant: 'muted' | 'warning' } | null {
  switch (book.recordingVerdict) {
    case 'same-recording': return { label: 'Already owned', variant: 'muted' };
    case 'different-recording': return { label: 'New version of an owned title', variant: 'muted' };
    case 'review': return { label: 'Possible duplicate (review)', variant: 'warning' };
  }
  if (book.isDuplicate && (book.duplicateReason === 'path' || book.duplicateReason === 'slug')) {
    return { label: 'Already owned', variant: 'muted' };
  }
  return null;
}

function ConfidenceBadge({ confidence, reason, paused }: { confidence?: Confidence | undefined; reason?: string | undefined; paused?: boolean | undefined }) {
  if (!confidence) {
    return paused ? (
      <Badge variant="muted">Paused</Badge>
    ) : (
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
export function ImportCard({ row, onToggle, onEdit, lockDuplicates, relativePath, paused, annotation }: ImportCardProps) {
  const isDuplicate = row.book.isDuplicate;
  const confidence = row.matchResult?.confidence;
  const showPencilAlways = !confidence || confidence === 'medium' || confidence === 'none';
  const displayTitle = row.edited.title;
  const displayAuthor = row.edited.author || row.book.parsedAuthor || '';
  // Mirror import precedence: explicit edited narrators win over matched metadata.
  const displayNarrator = row.edited.narrators?.length
    ? row.edited.narrators.join(', ')
    : row.edited.metadata?.narrators?.join(', ');
  // Mirror server precedence: edited series wins verbatim; blank defers to provider primary.
  // Trim only to classify, preserving displayed and stored whitespace.
  const matchedSeries = row.edited.series?.trim()
    ? { name: row.edited.series, position: row.edited.seriesPosition }
    : pickPrimarySeries(row.edited.metadata);
  const pathParts = row.book.path.split(/[\\/]/).filter(Boolean);
  const shortPath = relativePath ?? pathParts.slice(-3).join('/') ?? row.book.path;

  const isPathDuplicate = lockDuplicates && isDuplicate && row.book.duplicateReason === 'path';
  const isSlugDuplicate = lockDuplicates && isDuplicate && row.book.duplicateReason === 'slug';
  const showCheckbox = onToggle !== undefined && !isPathDuplicate && !isSlugDuplicate;
  const showEditButton = !isDuplicate || isSlugDuplicate;
  const ownership = annotation?.badge ?? ownershipBadge(row.book);
  // Trim only to classify, preserving displayed whitespace. Sole presence decision: the JSX tests
  // `!== null`, because a truthiness gate there would re-decide `''` and make this line untestable.
  const note = annotation?.note?.trim() ? annotation.note : null;

  const borderClass = confidence === 'none'
    ? 'border-l-[3px] border-l-amber-500'
    : confidence === 'medium'
      ? 'border-l-[3px] border-l-amber-500/40'
      : '';

  const dimClass = isDuplicate
    ? (row.selected ? '' : 'opacity-60')
    : (!confidence ? 'opacity-50' : '');

  return (
    <div
      className={`group flex items-center gap-3 px-4 py-3 transition-all duration-300 ${borderClass} ${dimClass} ${
        row.selected ? 'bg-primary/5' : 'hover:bg-muted/20'
      }`}
    >
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

      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium truncate">{displayTitle}</p>
        <p className="text-xs text-muted-foreground/50 truncate" title={row.book.path}>
          {shortPath}
        </p>
        {note !== null && (
          <p data-testid="import-card-note" className="text-xs text-amber-500/80 truncate" title={note}>
            {note}
          </p>
        )}
      </div>

      <div className="hidden sm:block w-64 shrink-0 text-right">
        <p className="text-sm text-muted-foreground truncate">
          {displayAuthor || <span className="italic text-muted-foreground/40">Unknown</span>}
        </p>
        {matchedSeries?.name && (
          <p className="text-xs text-muted-foreground/50 truncate">
            {matchedSeries.name}{matchedSeries.position != null ? ` #${matchedSeries.position}` : ''}
          </p>
        )}
        <p className="text-xs text-muted-foreground/50 truncate">
          {displayNarrator
            ? <span className="inline-flex items-center gap-1"><HeadphonesIcon className="w-2.5 h-2.5 shrink-0" />{displayNarrator} &middot; {formatBytes(row.book.totalSize)}</span>
            : <>{row.book.fileCount} file{row.book.fileCount !== 1 ? 's' : ''} &middot; {formatBytes(row.book.totalSize)}</>
          }
        </p>
      </div>

      <div className="w-32 shrink-0 flex justify-center">
        {ownership ? (
          <Badge variant={ownership.variant}>{ownership.label}</Badge>
        ) : (
          <ConfidenceBadge confidence={confidence} reason={row.matchResult?.reason} paused={paused} />
        )}
      </div>

      {/* Review warnings remain visible independently of match confidence. */}
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

      {row.book.previewUrl && (
        <AudioPreview
          source={{ kind: 'url', previewUrl: row.book.previewUrl, enabled: true }}
          size="compact"
        />
      )}

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
