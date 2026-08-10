import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useSearchParams } from 'react-router';
import { submissionResponseSchema } from '@core/import-staging/schemas.js';
import { api, ApiError, type SubmissionResponse } from '@/lib/api';
import { queryKeys } from '@/lib/queryKeys';
import { usePagination } from '@/hooks/usePagination';
import { useImportSubmissionDetail } from '@/hooks/useImportReport';
import { useDtoValid } from '@/lib/import-report/useDtoWarn';
import { detailToSummary } from '@/lib/import-report/detailToSummary';
import { patchImportHistoryCache } from '@/lib/import-report/cache';
import { Pagination } from '@/components/Pagination';
import { ConfirmModal } from '@/components/ConfirmModal';
import { LoadingSpinner, TrashIcon } from '@/components/icons';
import { DEFAULT_LIMITS } from '@shared/schemas/common.js';
import { ImportHistoryCard } from './ImportHistoryCard';
// The deletion hook owns the deep-link rule, so it owns the parser the rule keys on.
import { parseRun, useImportHistoryDeletion } from './useImportHistoryDeletion';

type PendingConfirm = { kind: 'run'; id: number } | { kind: 'clear' };

const RUN_CONFIRM = {
  title: 'Delete Import Run',
  message:
    'This removes this run’s import report only. The books it imported are not deleted, and the Activity event history keeps its record.',
  confirmLabel: 'Delete run',
};

const CLEAR_CONFIRM = {
  title: 'Clear Completed Runs',
  message:
    'This removes completed runs that had nothing held, skipped, or failed. Any run with held, skipped, or failed activity is preserved, the imported books are not deleted, and the Activity event history keeps its record.',
  confirmLabel: 'Clear completed runs',
};

/** One modal for both paths; the pending target picks the copy and the mutation to fire. */
function DeletionConfirm({ pending, onConfirm, onCancel }: {
  pending: PendingConfirm | null;
  onConfirm: (pending: PendingConfirm) => void;
  onCancel: () => void;
}) {
  const copy = pending?.kind === 'clear' ? CLEAR_CONFIRM : RUN_CONFIRM;
  return (
    <ConfirmModal
      isOpen={pending !== null}
      title={copy.title}
      message={copy.message}
      confirmLabel={copy.confirmLabel}
      onConfirm={() => { if (pending) onConfirm(pending); }}
      onCancel={onCancel}
    />
  );
}

/** The direct detail read is the sole header and error authority for every deep-linked run. */
function HydratedDeepLinkCard({ id, onDelete, isDeleting }: { id: number; onDelete: (id: number) => void; isDeleting: boolean }) {
  const query = useImportSubmissionDetail(id, true);
  // Validate before building a header; malformed detail belongs in this hydrator's error arm.
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
  return <ImportHistoryCard row={detailToSummary(query.data)} defaultExpanded onDelete={onDelete} isDeleting={isDeleting} />;
}

export function ImportHistorySection() {
  const [searchParams] = useSearchParams();
  const runId = parseRun(searchParams.get('run'));
  const pagination = usePagination(DEFAULT_LIMITS.eventHistory);
  const { clampToTotal } = pagination;
  const queryClient = useQueryClient();
  const { deleteMutation, clearMutation, error: deleteError } = useImportHistoryDeletion();
  const [confirming, setConfirming] = useState<PendingConfirm | null>(null);
  const requestDelete = (id: number) => setConfirming({ kind: 'run', id });
  const isDeleting = (id: number) => deleteMutation.isPending && deleteMutation.variables === id;

  const listQuery = useQuery({
    queryKey: queryKeys.importSubmissions.list({ limit: pagination.limit, offset: pagination.offset }),
    queryFn: () => api.listImportSubmissions({ limit: pagination.limit, offset: pagination.offset }),
    placeholderData: (prev) => prev,
  });

  const rows = listQuery.data?.data ?? [];
  const total = listQuery.data?.total ?? 0;
  const listData = listQuery.data;
  useEffect(() => { clampToTotal(total); }, [total, clampToTotal]);

  // Reapply detail after a late list arrival; validate first so malformed detail cannot poison list cache.
  useEffect(() => {
    if (runId == null || !listData) return;
    const detail = queryClient.getQueryData<SubmissionResponse>(queryKeys.importSubmissions.detail(runId));
    if (!detail) return;
    const parsed = submissionResponseSchema.safeParse(detail);
    if (parsed.success) patchImportHistoryCache(queryClient, parsed.data);
  }, [runId, listData, queryClient]);

  // Exclude the deep-linked id from list rows; the hydrated card is its sole header authority.
  const showHydrated = runId != null;
  const listRows = runId != null ? rows.filter((r) => r.id !== runId) : rows;

  const heading = (
    <div className="flex items-center gap-3">
      <h3 className="text-sm font-semibold text-muted-foreground">Import history</h3>
      <button
        type="button"
        onClick={() => setConfirming({ kind: 'clear' })}
        disabled={clearMutation.isPending}
        className="ml-auto flex items-center gap-1.5 rounded-lg bg-muted px-3 py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground disabled:opacity-50"
      >
        <TrashIcon className="w-3 h-3" />
        Clear completed
      </button>
    </div>
  );

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
          <ImportHistoryCard key={row.id} row={row} onDelete={requestDelete} isDeleting={isDeleting(row.id)} />
        ))}
      </div>
    );
  }

  return (
    <section className="space-y-3" data-testid="import-history-section">
      {heading}
      {deleteError && (
        <div className="rounded-lg border border-border p-3 text-sm text-destructive" data-testid="import-history-delete-error">
          {deleteError}
        </div>
      )}
      {showHydrated && <HydratedDeepLinkCard id={runId} onDelete={requestDelete} isDeleting={isDeleting(runId)} />}
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
      <DeletionConfirm
        pending={confirming}
        onConfirm={(pending) => {
          if (pending.kind === 'clear') clearMutation.mutate();
          else deleteMutation.mutate(pending.id);
          setConfirming(null);
        }}
        onCancel={() => setConfirming(null)}
      />
    </section>
  );
}
