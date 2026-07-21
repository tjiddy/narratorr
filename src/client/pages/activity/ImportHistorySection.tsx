import { useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';
import { api, ApiError, type SubmissionResponse, type SubmissionSummary } from '@/lib/api';
import { queryKeys } from '@/lib/queryKeys';
import { usePagination } from '@/hooks/usePagination';
import { useImportSubmissionDetail } from '@/hooks/useImportReport';
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

/** Strip `items` and force the summary arm — cards render header-only. */
function toSummary(detail: SubmissionResponse): SubmissionSummary {
  const { items: _items, ...rest } = detail as SubmissionResponse & { items?: unknown };
  return { ...rest, itemsIncluded: false } as SubmissionSummary;
}

/**
 * Off-page deep-link hydration (#1894, F59/F64). A `run` outside the current page
 * is hydrated by a direct GET; a 404 degrades to a "no longer available"
 * placeholder (no retry), a transient failure to an error card WITH retry. Either
 * way the rest of the section stays usable.
 */
function HydratedDeepLinkCard({ id }: { id: number }) {
  const query = useImportSubmissionDetail(id, true);
  if (query.isError) {
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
  return <ImportHistoryCard row={toSummary(query.data)} defaultExpanded />;
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
  const showHydrated = runId != null && !onPage && !listQuery.isLoading && !listQuery.isError;

  const heading = <h3 className="text-sm font-semibold text-muted-foreground">Import history</h3>;

  if (listQuery.isLoading) {
    return (
      <section className="space-y-3" data-testid="import-history-section">
        {heading}
        <div className="flex justify-center py-6"><LoadingSpinner className="w-6 h-6 text-primary" /></div>
      </section>
    );
  }

  if (listQuery.isError) {
    return (
      <section className="space-y-3" data-testid="import-history-section">
        {heading}
        <div className="flex items-center gap-3 rounded-lg border border-border p-3 text-sm text-destructive">
          <span>Couldn’t load import history.</span>
          <button type="button" className="underline" onClick={() => listQuery.refetch()}>Retry</button>
        </div>
      </section>
    );
  }

  return (
    <section className="space-y-3" data-testid="import-history-section">
      {heading}
      {showHydrated && <HydratedDeepLinkCard id={runId} />}
      {total === 0 && !showHydrated ? (
        <div className="rounded-lg border border-border p-6 text-center text-sm text-muted-foreground" data-testid="import-history-empty">
          No import history yet.
        </div>
      ) : (
        <div className="space-y-2">
          {rows.map((row) => (
            <ImportHistoryCard key={row.id} row={row} defaultExpanded={row.id === runId} />
          ))}
        </div>
      )}
      {total > 0 && (
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
