import { formatBytes } from '@/lib/api';
import { QualityComparisonPanel } from '@/pages/activity/QualityComparisonPanel';
import type { QualityGateData } from '@/lib/api/activity';

type Reason = Record<string, unknown> | null;
type IndexerMap = Map<number, string>;

/** Returns false for null or empty-object reasons (treat {} same as null for toggle visibility). */
export function hasReasonContent(reason: Reason): boolean {
  if (reason == null) return false;
  return Object.keys(reason).length > 0;
}

/** Returns an inline summary string for grabbed events, null for all others. */
export function getEventSummary(eventType: string, reason: Reason, indexerMap: IndexerMap): string | null {
  if (reason == null || eventType !== 'grabbed') return null;
  const indexerId = reason.indexerId as number | undefined;
  const size = reason.size as number | undefined;
  const protocol = reason.protocol as string | undefined;

  const indexerName = indexerId != null ? (indexerMap.get(indexerId) ?? String(indexerId)) : null;
  const protocolLabel = protocol ? protocol.charAt(0).toUpperCase() + protocol.slice(1) : null;
  const sizeLabel = size != null ? formatBytes(size) : null;

  const parts: string[] = [];
  if (indexerName) parts.push(`from ${indexerName}`);
  if (protocolLabel) parts.push(`(${protocolLabel})`);
  if (sizeLabel) parts.push(`· ${sizeLabel}`);
  return parts.length > 0 ? parts.join(' ') : null;
}

function KeyValueRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex gap-2 text-xs">
      <span className="text-muted-foreground shrink-0">{label}:</span>
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
      {protocol && <KeyValueRow label="Protocol" value={protocol.charAt(0).toUpperCase() + protocol.slice(1)} />}
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
      {mode && <KeyValueRow label="Mode" value={mode.charAt(0).toUpperCase() + mode.slice(1)} />}
      {fileCount != null && <KeyValueRow label="Files" value={String(fileCount)} />}
      {totalSize != null && <KeyValueRow label="Size" value={formatBytes(totalSize)} />}
    </div>
  );
}

function ErrorDetails({ reason }: { reason: Record<string, unknown> }) {
  const error = reason.error as string | undefined;
  if (!error) return <GenericDetails reason={reason} />;
  return (
    <div className="text-xs text-destructive break-all">
      {error}
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
  if (Renderer) {
    return (
      <div className="mt-2 bg-muted/50 rounded-xl p-3">
        <Renderer reason={reason} indexerMap={indexerMap} />
      </div>
    );
  }
  return (
    <div className="mt-2 bg-muted/50 rounded-xl p-3">
      <GenericDetails reason={reason} />
    </div>
  );
}
