import { useEffect } from 'react';
import { formatBytes } from '@/lib/api';
import { capitalize } from '@/lib/eventReasonHelpers';
import { qualityGateReasonSchema } from '../../shared/schemas.js';
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
  // Signal-on-failure, guarded against per-re-render spam. Logging in an effect keyed on
  // `reason` fires once per distinct blob (not once per render of the same blob) and keeps
  // the warn out of the render body. Type drift or a legacy/malformed blob lands in the
  // fallback branch; without this signal the panel silently degrades to the generic dump
  // with no trace of why. (console.debug is lint-forbidden; this mirrors the warn precedent
  // in src/client/lib/sse/safe-parse-event.ts.)
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

// --- Earwitness attribution analysis (#1528) ---------------------------------
// `reason.detected`/per-field strings are untrusted provider text: rendered as
// React string children (auto-escaped), never via dangerouslySetInnerHTML.

/** Neutral status pill. `partial` and `unknown` are intentionally NOT styled as
 * errors — only `mismatch` is a contradiction signal. */
function statusPillClass(status: string | undefined): string {
  switch (status) {
    case 'match': return 'bg-success/10 text-success';
    case 'mismatch': return 'bg-destructive/10 text-destructive';
    default: return 'bg-muted text-muted-foreground'; // partial, unknown, anything else
  }
}

function AttributionStatusPill({ status }: { status: string | undefined }) {
  if (!status) return null;
  return (
    <span className={`text-[11px] px-1.5 py-0.5 rounded-md font-medium ${statusPillClass(status)}`}>
      {capitalize(status)}
    </span>
  );
}

function toDisplay(value: unknown): string {
  if (value == null) return '—';
  if (Array.isArray(value)) return value.length ? value.join(', ') : '—';
  return String(value);
}

function AttributionFieldRow({ label, field }: { label: string; field: Record<string, unknown> | undefined }) {
  if (!field) return null;
  const status = field.status as string | undefined;
  return (
    <div className="flex flex-col gap-0.5 text-xs leading-relaxed border-t border-border/40 pt-1.5 first:border-0 first:pt-0">
      <div className="flex items-center gap-2">
        <span className="text-muted-foreground/70 w-16 shrink-0">{label}</span>
        <AttributionStatusPill status={status} />
      </div>
      <KeyValueRow label="Expected" value={toDisplay(field.expected)} />
      <KeyValueRow label="Heard" value={toDisplay(field.detected)} />
    </div>
  );
}

function AttributionAnalysisDetails({ reason }: { reason: Record<string, unknown> }) {
  const outcome = reason.outcome as string | undefined;

  if (outcome === 'permanent_failure') {
    // Surface earwitness's message verbatim — tells the human re-rip vs path issue.
    return (
      <div className="space-y-1">
        <KeyValueRow label="Result" value="Couldn't process" />
        <ErrorDetails reason={{ error: reason.message }} />
      </div>
    );
  }

  if (outcome === 'transient_failure') {
    return (
      <div className="space-y-1">
        <div className="flex items-start gap-2 text-xs text-amber-400">
          <AlertCircleIcon className="w-3.5 h-3.5 shrink-0 mt-0.5" />
          <span className="break-all">earwitness temporarily unavailable — try again. {toDisplay(reason.message)}</span>
        </div>
      </div>
    );
  }

  const attributionPresent = reason.attributionPresent as boolean | undefined;
  const confidence = reason.confidence as number | undefined;
  const comparisonStatus = reason.comparisonStatus as string | undefined;
  const fields = reason.fields as Record<string, Record<string, unknown>> | null | undefined;

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2 text-xs">
        <span className="text-muted-foreground/70 w-16 shrink-0">Overall</span>
        {attributionPresent === false ? (
          <span className="text-[11px] px-1.5 py-0.5 rounded-md font-medium bg-muted text-muted-foreground">Unverified</span>
        ) : (
          <AttributionStatusPill status={comparisonStatus} />
        )}
      </div>
      {confidence != null && <KeyValueRow label="Confidence" value={`${Math.round(confidence * 100)}%`} />}
      {attributionPresent !== false && fields && (
        <div className="space-y-1.5">
          <AttributionFieldRow label="Title" field={fields.title} />
          <AttributionFieldRow label="Authors" field={fields.authors} />
          <AttributionFieldRow label="Narrators" field={fields.narrators} />
        </div>
      )}
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

const DETAIL_RENDERERS: Record<string, React.FC<{ reason: Record<string, unknown>; indexerMap: IndexerMap }>> = {
  grabbed: ({ reason, indexerMap }) => <GrabbedDetails reason={reason} indexerMap={indexerMap} />,
  download_completed: ({ reason }) => <DownloadCompletedDetails reason={reason} />,
  imported: ({ reason }) => <ImportedDetails reason={reason} />,
  import_failed: ({ reason }) => <ErrorDetails reason={reason} />,
  merge_failed: ({ reason }) => <ErrorDetails reason={reason} />,
  download_failed: ({ reason }) => <ErrorDetails reason={reason} />,
  held_for_review: ({ reason }) => <HeldForReviewDetails reason={reason} />,
  grab_failed: ({ reason }) => <GrabFailedDetails reason={reason} />,
  attribution_analysis: ({ reason }) => <AttributionAnalysisDetails reason={reason} />,
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
