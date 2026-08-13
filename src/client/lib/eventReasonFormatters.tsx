import { useEffect } from 'react';
import { formatBytes } from '@/lib/api';
import { capitalize } from '@/lib/eventReasonHelpers';
import { qualityGateReasonSchema } from '@shared/schemas.js';
import { OPF_BACKUP_FILENAME } from '@core/utils/opf-regex.js';
import { QualityComparisonPanel } from '@/pages/activity/QualityComparisonPanel';
import { AlertCircleIcon } from '@/components/icons';

type IndexerMap = Map<number, string>;

function KeyValueRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex gap-2 text-xs leading-relaxed">
      <span className="text-muted-foreground/70 shrink-0 w-16">{label}:</span>
      <span className="text-foreground break-all">{value}</span>
    </div>
  );
}

function GrabbedDetails({ reason, indexerMap }: { reason: Record<string, unknown>; indexerMap: IndexerMap }) {
  const indexerId = reason.indexerId as number | undefined;
  const indexerName = indexerId != null ? (indexerMap.get(indexerId) ?? String(indexerId)) : '—';
  const protocol = reason.protocol as string | undefined;
  const size = reason.size as number | undefined;

  return (
    <div className="space-y-1">
      {indexerId != null && <KeyValueRow label="Indexer" value={indexerName} />}
      {protocol && <KeyValueRow label="Protocol" value={capitalize(protocol)} />}
      {size != null && <KeyValueRow label="Size" value={formatBytes(size)} />}
    </div>
  );
}

function DownloadCompletedDetails({ reason }: { reason: Record<string, unknown> }) {
  const progress = reason.progress as number | undefined;
  return (
    <div className="space-y-1">
      {progress != null && <KeyValueRow label="Progress" value={`${Math.round(progress * 100)}%`} />}
    </div>
  );
}

function ImportedDetails({ reason }: { reason: Record<string, unknown> }) {
  const targetPath = reason.targetPath as string | undefined;
  const mode = reason.mode as string | undefined;
  const fileCount = reason.fileCount as number | undefined;
  const totalSize = reason.totalSize as number | undefined;

  return (
    <div className="space-y-1">
      {targetPath && <KeyValueRow label="Path" value={targetPath} />}
      {mode && <KeyValueRow label="Mode" value={capitalize(mode)} />}
      {fileCount != null && <KeyValueRow label="Files" value={String(fileCount)} />}
      {totalSize != null && <KeyValueRow label="Size" value={formatBytes(totalSize)} />}
    </div>
  );
}

function ErrorDetails({ reason }: { reason: Record<string, unknown> }) {
  const error = reason.error as string | undefined;
  if (!error) return <GenericDetails reason={reason} />;
  return (
    <div className="flex items-start gap-2 text-xs text-destructive">
      <AlertCircleIcon className="w-3.5 h-3.5 shrink-0 mt-0.5" />
      <span className="break-all">{error}</span>
    </div>
  );
}

function HeldForReviewDetails({ reason }: { reason: Record<string, unknown> }) {
  // Effect-scoped warning avoids render-body logging and repeats only for a new reason object.
  useEffect(() => {
    const result = qualityGateReasonSchema.safeParse(reason);
    if (!result.success) {
      console.warn('quality-gate reason failed schema validation', result.error);
    }
  }, [reason]);

  const parsed = qualityGateReasonSchema.safeParse(reason);
  if (!parsed.success) {
    return (
      <div className="mt-2 p-3 bg-muted/50 rounded-xl border border-border/50 animate-fade-in">
        <GenericDetails reason={reason} />
      </div>
    );
  }
  return <QualityComparisonPanel data={parsed.data} />;
}

function GrabFailedDetails({ reason }: { reason: Record<string, unknown> }) {
  const releaseTitle = reason.release_title as string | undefined;
  return (
    <div className="space-y-2">
      {releaseTitle && <KeyValueRow label="Release" value={releaseTitle} />}
      <ErrorDetails reason={reason} />
    </div>
  );
}

function SearchRelaxedHeldDetails({ reason }: { reason: Record<string, unknown> }) {
  const relaxedQuery = reason.relaxed_query as string | undefined;
  const variantTag = reason.variant_tag as string | undefined;
  const releaseTitle = reason.release_title as string | undefined;
  return (
    <div className="space-y-1">
      {relaxedQuery && <KeyValueRow label="Relaxed query" value={relaxedQuery} />}
      {variantTag && <KeyValueRow label="Title variant" value={variantTag} />}
      {releaseTitle && <KeyValueRow label="Top candidate" value={releaseTitle} />}
    </div>
  );
}

const OPF_FIELD_LABELS: Record<string, string> = {
  title: 'Title', subtitle: 'Subtitle', authors: 'Authors', narrators: 'Narrators',
  description: 'Description', publisher: 'Publisher', publishedDate: 'Published',
  asin: 'ASIN', isbn: 'ISBN', seriesName: 'Series', seriesPosition: 'Series #', genres: 'Genres',
};

function formatPreviousValue(value: unknown): string {
  if (value === null || value === undefined) return '(none)';
  if (Array.isArray(value)) return value.length === 0 ? '(none)' : value.join(', ');
  return String(value);
}

function SidecarDivergedDetails({ reason, bookPath }: { reason: Record<string, unknown>; bookPath: string | null }) {
  const changedFields = Array.isArray(reason.changed_fields) ? (reason.changed_fields as string[]) : [];
  const previous = (reason.previous ?? {}) as Record<string, unknown>;
  const previousUnavailable = reason.previous_unavailable === true;
  const generatedUnparseable = reason.generated_unparseable === true;
  const equivalenceUnproven = reason.equivalence_unproven === true;

  return (
    <div className="space-y-1">
      {previousUnavailable && generatedUnparseable ? (
        <p className="text-xs text-muted-foreground">
          Neither the replaced sidecar nor the regenerated one yielded readable metadata, so no field
          names could be recovered from either document. The replaced file is preserved in full.
        </p>
      ) : previousUnavailable ? (
        <p className="text-xs text-muted-foreground">
          The replaced sidecar yielded no readable metadata, so its previous values could not be
          summarised here. The complete replaced file is preserved.
        </p>
      ) : (
        <>
          {equivalenceUnproven && (
            <p className="text-xs text-muted-foreground">
              These values could not be compared beyond the metadata reader&apos;s length limits, so
              the sidecar was preserved rather than assumed unchanged.
            </p>
          )}
          {generatedUnparseable && (
            <p className="text-xs text-muted-foreground">
              The regenerated sidecar yielded no readable metadata; the values below are the ones
              that were at risk.
            </p>
          )}
          {changedFields.map((field) => (
            <KeyValueRow
              key={field}
              label={OPF_FIELD_LABELS[field] ?? field}
              value={formatPreviousValue(previous[field])}
            />
          ))}
        </>
      )}
      {/* Composed from the book's current folder plus the writer's own filename constant, not a
          stored path: events are append-only, so a path recorded at write time would go stale on
          the first rename, and a second literal here could drift from where the writer puts it. */}
      {bookPath ? (
        <KeyValueRow label="Backup" value={`${bookPath}/${OPF_BACKUP_FILENAME}`} />
      ) : (
        <p className="text-xs text-muted-foreground">
          This book is no longer in the library, so its backup file location is gone.
        </p>
      )}
      <p className="text-xs text-muted-foreground/70">
        Values shown are a summary; the book&apos;s latest backup file holds the replaced sidecar in full.
      </p>
    </div>
  );
}

function GenericDetails({ reason }: { reason: Record<string, unknown> }) {
  const entries = Object.entries(reason).filter(([, v]) => v != null);
  if (entries.length === 0) return null;
  return (
    <div className="space-y-1">
      {entries.map(([key, value]) => (
        <KeyValueRow
          key={key}
          label={key.replace(/([A-Z])/g, ' $1').replace(/^./, (s) => s.toUpperCase())}
          value={typeof value === 'object' ? JSON.stringify(value) : String(value)}
        />
      ))}
    </div>
  );
}

interface DetailRendererProps {
  reason: Record<string, unknown>;
  indexerMap: IndexerMap;
  /** The book's current folder; renderers that name a file compose it from this, never from `reason`. */
  bookPath: string | null;
}

const DETAIL_RENDERERS: Record<string, React.FC<DetailRendererProps>> = {
  grabbed: ({ reason, indexerMap }) => <GrabbedDetails reason={reason} indexerMap={indexerMap} />,
  download_completed: ({ reason }) => <DownloadCompletedDetails reason={reason} />,
  imported: ({ reason }) => <ImportedDetails reason={reason} />,
  import_failed: ({ reason }) => <ErrorDetails reason={reason} />,
  merge_failed: ({ reason }) => <ErrorDetails reason={reason} />,
  download_failed: ({ reason }) => <ErrorDetails reason={reason} />,
  held_for_review: ({ reason }) => <HeldForReviewDetails reason={reason} />,
  grab_failed: ({ reason }) => <GrabFailedDetails reason={reason} />,
  search_relaxed_held: ({ reason }) => <SearchRelaxedHeldDetails reason={reason} />,
  sidecar_diverged: ({ reason, bookPath }) => <SidecarDivergedDetails reason={reason} bookPath={bookPath} />,
};

export function EventReasonDetails({ eventType, reason, indexerMap, bookPath = null }: {
  eventType: string;
  reason: Record<string, unknown>;
  indexerMap: IndexerMap;
  bookPath?: string | null;
}) {
  const Renderer = DETAIL_RENDERERS[eventType];
  const isHeldForReview = eventType === 'held_for_review';

  if (isHeldForReview && Renderer) {
    return <Renderer reason={reason} indexerMap={indexerMap} bookPath={bookPath} />;
  }

  return (
    <div className="mt-2 p-3 bg-muted/50 rounded-xl border border-border/50 animate-fade-in">
      {Renderer ? (
        <Renderer reason={reason} indexerMap={indexerMap} bookPath={bookPath} />
      ) : (
        <GenericDetails reason={reason} />
      )}
    </div>
  );
}
