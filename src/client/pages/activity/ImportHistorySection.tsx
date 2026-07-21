import { useEffect } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';
import { submissionResponseSchema } from '@core/import-staging/schemas.js';
import { api, ApiError, type SubmissionResponse } from '@/lib/api';
import { queryKeys } from '@/lib/queryKeys';
import { usePagination } from '@/hooks/usePagination';
import { useImportSubmissionDetail } from '@/hooks/useImportReport';
import { useDtoValid } from '@/lib/import-report/useDtoWarn';
import { detailToSummary } from '@/lib/import-report/detailToSummary';
import { patchImportHistoryCache } from '@/lib/import-report/cache';
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
 * The SINGLE deep-link hydration authority for a `run` id (#1894, F59/F64/F43/F44).
 * EVERY deep-linked id — on-page or off-page — renders through this card so there is
 * exactly one 404-aware authority and one header source (the direct detail read),
 * never the list row. A 404 degrades to a "no longer available" placeholder (no
 * retry); a transient failure to an error card WITH retry; the header comes from the
 * detail (so a late/stale list response for the same id can never revert it).
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
  const queryClient = useQueryClient();

  const listQuery = useQuery({
    queryKey: queryKeys.importSubmissions.list({ limit: pagination.limit, offset: pagination.offset }),
    queryFn: () => api.listImportSubmissions({ limit: pagination.limit, offset: pagination.offset }),
    placeholderData: (prev) => prev,
  });

  const rows = listQuery.data?.data ?? [];
  const total = listQuery.data?.total ?? 0;
  const listData = listQuery.data;
  useEffect(() => { clampToTotal(total); }, [total, clampToTotal]);

  // Reconcile the deep-link target's terminal detail into the list cache (F47). When
  // the detail completed BEFORE the list arrived, the in-queryFn patch ran against an
  // empty cache, so the arriving list stored a stale pre-terminal row. Re-patch once
  // the list data is present (the patch is a no-op when nothing advances), so removing
  // `run` — which unmounts the hydrated authority — reveals a TERMINAL ordinary card,
  // never the stale processing header.
  useEffect(() => {
    if (runId == null || !listData) return;
    const detail = queryClient.getQueryData<SubmissionResponse>(queryKeys.importSubmissions.detail(runId));
    if (detail) patchImportHistoryCache(queryClient, detail);
  }, [runId, listData, queryClient]);

  // The deep-link target is ALWAYS rendered by the single hydration authority (F43/F44),
  // independent of the list request (F28). The list rows EXCLUDE that id so it is never
  // rendered twice and its header can never be reverted by a stale list row.
  const showHydrated = runId != null;
  const listRows = runId != null ? rows.filter((r) => r.id !== runId) : rows;

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
        {listRows.map((row) => (
          <ImportHistoryCard key={row.id} row={row} />
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
