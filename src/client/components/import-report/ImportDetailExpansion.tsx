import { submissionResponseSchema } from '@core/import-staging/schemas.js';
import { useImportSubmissionDetail } from '@/hooks/useImportReport';
import { useDtoValid } from '@/lib/import-report/useDtoWarn';
import { ImportAttentionRows } from './ImportAttentionRows';

/**
 * Shared detail body for last-import and Activity. Processing snapshots self-poll;
 * cold and refresh failures remain retryable, and pruned details render as expired.
 */
export function ImportDetailExpansion({ id, enabled = true }: { id: number; enabled?: boolean }) {
  const query = useImportSubmissionDetail(id, enabled);
  const detail = query.data;
  const valid = useDtoValid(submissionResponseSchema, detail, 'import submission detail');

  // Cold failure: no retained data to render.
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

  // Refresh failure keeps last-good rows and adds a retry.
  const refreshBanner = query.isError ? (
    <div className="flex items-center gap-2 py-1 text-xs text-destructive" data-testid="import-detail-refresh-error">
      <span>Couldn’t refresh — showing the last result.</span>
      <button type="button" className="underline" onClick={() => query.refetch()}>Retry</button>
    </div>
  ) : null;

  let body: React.ReactNode;
  if (!detail.itemsIncluded) {
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
