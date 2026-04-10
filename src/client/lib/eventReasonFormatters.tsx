import { formatBytes } from '@/lib/api';
import { capitalize } from '@/lib/eventReasonHelpers';
import { QualityComparisonPanel } from '@/pages/activity/QualityComparisonPanel';
import { AlertCircleIcon } from '@/components/icons';
import type { QualityGateData } from '@/lib/api/activity';

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
      <KeyValueRow label="Indexer" value={indexerName} />
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
  return <QualityComparisonPanel data={reason as unknown as QualityGateData} />;
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

const DETAIL_RENDERERS: Record<string, React.FC<{ reason: Record<string, unknown>; indexerMap: IndexerMap }>> = {
  grabbed: ({ reason, indexerMap }) => <GrabbedDetails reason={reason} indexerMap={indexerMap} />,
  download_completed: ({ reason }) => <DownloadCompletedDetails reason={reason} />,
  imported: ({ reason }) => <ImportedDetails reason={reason} />,
  upgraded: ({ reason }) => <ImportedDetails reason={reason} />,
  import_failed: ({ reason }) => <ErrorDetails reason={reason} />,
  merge_failed: ({ reason }) => <ErrorDetails reason={reason} />,
  download_failed: ({ reason }) => <ErrorDetails reason={reason} />,
  held_for_review: ({ reason }) => <HeldForReviewDetails reason={reason} />,
};

/** Renders formatted event reason details based on event type. */
export function EventReasonDetails({ eventType, reason, indexerMap }: {
  eventType: string;
  reason: Record<string, unknown>;
  indexerMap: IndexerMap;
}) {
  const Renderer = DETAIL_RENDERERS[eventType];
  const isHeldForReview = eventType === 'held_for_review';

  if (isHeldForReview && Renderer) {
    return <Renderer reason={reason} indexerMap={indexerMap} />;
  }

  return (
    <div className="mt-2 p-3 bg-muted/50 rounded-xl border border-border/50 animate-fade-in">
      {Renderer ? (
        <Renderer reason={reason} indexerMap={indexerMap} />
      ) : (
        <GenericDetails reason={reason} />
      )}
    </div>
  );
}
