import { useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';
import { submissionResponseSchema } from '@core/import-staging/schemas.js';
import { api, ApiError } from '@/lib/api';
import { queryKeys } from '@/lib/queryKeys';
import { usePagination } from '@/hooks/usePagination';
import { useImportSubmissionDetail } from '@/hooks/useImportReport';
import { useDtoValid } from '@/lib/import-report/useDtoWarn';
import { detailToSummary } from '@/lib/import-report/detailToSummary';
import { Pagination } from '@/components/Pagination';
import { LoadingSpinner } from '@/components/icons';
import { DEFAULT_LIMITS } from '../../../shared/schemas/common.js';
import { ImportHistoryCard } from './ImportHistoryCard';

/** Positive-integer deep-link `run` param, else null (invalid/non-positive → ignored). */
function parseRun(value: string | null): number | null {
  if (value == null || !/^\d+$/.test(value)) return null;
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : null;
}

/**
 * Off-page deep-link hydration (#1894, F59/F64). A `run` outside the current page
 * is hydrated by a direct GET; a 404 degrades to a "no longer available"
 * placeholder (no retry), a transient failure to an error card WITH retry. Either
 * way the rest of the section stays usable.
 */
function HydratedDeepLinkCard({ id }: { id: number }) {
  const query = useImportSubmissionDetail(id, true);
  // Validate BEFORE converting the raw response into a card header (F29): a
  // malformed off-page header must render an error, never reach StatusChip/counts.
  const valid = useDtoValid(submissionResponseSchema, query.data, 'deep-link import submission');
  if (query.isError && !query.data) {
    const status = query.error instanceof ApiError ? query.error.status : undefined;
    if (status === 404) {
      return (
        <div className="rounded-lg border border-border p-3 text-sm text-muted-foreground" data-testid="import-run-unavailable">
          This import run is no longer available.
        </div>
      );
    }
    return (
      <div className="flex items-center gap-3 rounded-lg border border-border p-3 text-sm text-destructive">
        <span>Couldn’t load this import run.</span>
        <button type="button" className="underline" onClick={() => query.refetch()}>Retry</button>
      </div>
    );
  }
  if (!query.data) {
    return <div className="rounded-lg border border-border p-3 text-sm text-muted-foreground">Loading import run…</div>;
  }
  if (!valid) {
    return <div className="rounded-lg border border-border p-3 text-sm text-destructive" data-testid="import-run-malformed">This import run couldn’t be displayed.</div>;
  }
  return <ImportHistoryCard row={detailToSummary(query.data)} defaultExpanded />;
}

/**
 * Activity → History → "Import history" section (#1894). Paginated durable-record
 * cards, newest-first, rendered ABOVE the event-history list. Empty state does NOT
 * suppress the event-history list below it. A valid deep-link `run` auto-expands
 * its card (hydrating off-page targets, deduped by id).
 */
export function ImportHistorySection() {
  const [searchParams] = useSearchParams();
  const runId = parseRun(searchParams.get('run'));
  const pagination = usePagination(DEFAULT_LIMITS.eventHistory);
  const { clampToTotal } = pagination;

  const listQuery = useQuery({
    queryKey: queryKeys.importSubmissions.list({ limit: pagination.limit, offset: pagination.offset }),
    queryFn: () => api.listImportSubmissions({ limit: pagination.limit, offset: pagination.offset }),
    placeholderData: (prev) => prev,
  });

  const rows = listQuery.data?.data ?? [];
  const total = listQuery.data?.total ?? 0;
  useEffect(() => { clampToTotal(total); }, [total, clampToTotal]);

  const onPage = runId != null && rows.some((r) => r.id === runId);
  // The deep-link direct GET is INDEPENDENT of the list request (F28): render the
  // hydrated card whenever the run is not already on the current page — INCLUDING
  // while the list is loading or has failed. `onPage` only becomes true once list
  // data actually contains the id, at which point the on-page auto-expanded card
  // takes over (no duplication).
  const showHydrated = runId != null && !onPage;

  const heading = <h3 className="text-sm font-semibold text-muted-foreground">Import history</h3>;

  let listBody: React.ReactNode;
  if (listQuery.isLoading) {
    listBody = <div className="flex justify-center py-6"><LoadingSpinner className="w-6 h-6 text-primary" /></div>;
  } else if (listQuery.isError) {
    listBody = (
      <div className="flex items-center gap-3 rounded-lg border border-border p-3 text-sm text-destructive">
        <span>Couldn’t load import history.</span>
        <button type="button" className="underline" onClick={() => listQuery.refetch()}>Retry</button>
      </div>
    );
  } else if (total === 0 && !showHydrated) {
    listBody = (
      <div className="rounded-lg border border-border p-6 text-center text-sm text-muted-foreground" data-testid="import-history-empty">
        No import history yet.
      </div>
    );
  } else {
    listBody = (
      <div className="space-y-2">
        {rows.map((row) => (
          <ImportHistoryCard key={row.id} row={row} defaultExpanded={row.id === runId} />
        ))}
      </div>
    );
  }

  return (
    <section className="space-y-3" data-testid="import-history-section">
      {heading}
      {showHydrated && <HydratedDeepLinkCard id={runId} />}
      {listBody}
      {!listQuery.isLoading && !listQuery.isError && total > 0 && (
        <Pagination
          page={pagination.page}
          totalPages={pagination.totalPages(total)}
          total={total}
          limit={pagination.limit}
          onPageChange={pagination.setPage}
        />
      )}
    </section>
  );
}
