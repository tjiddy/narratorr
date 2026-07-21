import { submissionResponseSchema } from '@core/import-staging/schemas.js';
import { useImportSubmissionDetail } from '@/hooks/useImportReport';
import { useDtoValid } from '@/lib/import-report/useDtoWarn';
import { ImportAttentionRows } from './ImportAttentionRows';

/**
 * Shared expansion body for the last-import panel and the Activity import-history
 * cards (#1894). Uses the self-polling report-detail hook (F74/F81) so a snapshot
 * taken during `processing` advances to its terminal held/failed/skipped rows on
 * completion without a remount, on every surface (panel, on-page, off-page). Shows
 * attention rows only (accepted is count-only, rendered by the parent); a pruned
 * record collapses to a "details expired" affordance; failures are per-expansion
 * retryable; a malformed DTO renders an error (with an effect-keyed warn).
 */
export function ImportDetailExpansion({ id, enabled = true }: { id: number; enabled?: boolean }) {
  const query = useImportSubmissionDetail(id, enabled);
  const detail = query.data;
  const valid = useDtoValid(submissionResponseSchema, detail, 'import submission detail');

  // COLD failure only — no retained data to fall back on → replacement error + retry.
  if (query.isError && !detail) {
    return (
      <div className="flex items-center gap-3 py-2 text-sm text-destructive" data-testid="import-detail-error">
        <span>Couldn’t load import details.</span>
        <button type="button" className="underline" onClick={() => query.refetch()}>Retry</button>
      </div>
    );
  }

  if (!detail) {
    return <div className="py-2 text-sm text-muted-foreground" data-testid="import-detail-loading">Loading details…</div>;
  }

  if (!valid) {
    return <div className="py-2 text-sm text-destructive">Import details were malformed.</div>;
  }

  // A BACKGROUND poll failure (retained `detail` present) must NOT blank the rows:
  // keep last-good content and surface a subtle retry affordance (F30).
  const refreshBanner = query.isError ? (
    <div className="flex items-center gap-2 py-1 text-xs text-destructive" data-testid="import-detail-refresh-error">
      <span>Couldn’t refresh — showing the last result.</span>
      <button type="button" className="underline" onClick={() => query.refetch()}>Retry</button>
    </div>
  ) : null;

  let body: React.ReactNode;
  if (!detail.itemsIncluded) {
    // Summary arm reached via detail → the item rows were pruned (details expired).
    body = <div className="py-2 text-sm text-muted-foreground" data-testid="import-details-expired">Details expired.</div>;
  } else {
    const attention = detail.items.filter((i) => i.disposition !== 'accepted' && i.disposition !== 'pending');
    body = attention.length === 0
      ? <div className="py-2 text-sm text-muted-foreground">No items need attention.</div>
      : <ImportAttentionRows items={detail.items} />;
  }

  return (
    <>
      {refreshBanner}
      {body}
    </>
  );
}
