import { useState, useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { api, type ImportListExclusion } from '@/lib/api';
import { queryKeys } from '@/lib/queryKeys';
import { ConfirmModal } from '@/components/ConfirmModal';
import { Pagination } from '@/components/Pagination';
import { Tabs } from '@/components/Tabs';
import { usePagination } from '@/hooks/usePagination';
import { DEFAULT_LIMITS } from '@shared/schemas/common.js';
import type { ImportListExclusionKind } from '@shared/schemas/import-list-exclusion.js';
import { LoadingSpinner, XCircleIcon } from '@/components/icons';
import { ImportListExclusionRow } from './ImportListExclusionRow';
import { KIND_TABS } from './importListExclusionKind';

const EMPTY_STATE: Record<ImportListExclusionKind, { heading: string; detail: string }> = {
  deleted: {
    heading: 'No deleted books',
    detail: "Deleting a book that an import list added excludes it, so the list won't add it back",
  },
  added: {
    heading: 'No books added by a list',
    detail: 'When a list adds a book it records it here, so renaming the book later cannot make the list add it a second time',
  },
};

const REMOVE_CONSEQUENCE: Record<ImportListExclusionKind, string> = {
  deleted: 'An import list may add it again on its next sync.',
  added: 'The import list will treat this book as new and may add it again.',
};

/**
 * Which kind the previous query was for, read from its key rather than from a row.
 *
 * A row-derived kind (`data[0]?.kind`) cannot answer for an EMPTY page — precisely the case that
 * would otherwise slip the other tab's placeholder through.
 */
function kindOfQueryKey(key: readonly unknown[] | undefined): ImportListExclusionKind | undefined {
  const params = key?.[1];
  if (typeof params !== 'object' || params === null) return undefined;
  const kind = (params as { kind?: unknown }).kind;
  return kind === 'added' || kind === 'deleted' ? kind : undefined;
}

export function ImportListExclusionsSettings() {
  const queryClient = useQueryClient();
  const [deleteTarget, setDeleteTarget] = useState<ImportListExclusion | null>(null);
  const [kind, setKind] = useState<ImportListExclusionKind>('deleted');
  const pagination = usePagination(DEFAULT_LIMITS.importListExclusions);
  const { clampToTotal } = pagination;

  const paginationParams = { limit: pagination.limit, offset: pagination.offset, kind };
  const { data: response, isLoading, isError, refetch } = useQuery({
    queryKey: queryKeys.importListExclusions(paginationParams),
    queryFn: () => api.getImportListExclusions(paginationParams),
    // Kind-scoped: page-to-page navigation within one kind stays spinner-free, but a kind change
    // withholds the placeholder so the newly selected tab can never render the other one's rows,
    // total or pagination — not even for the pending window.
    placeholderData: (previousData, previousQuery) =>
      kindOfQueryKey(previousQuery?.queryKey) === kind ? previousData : undefined,
  });
  const entries = response?.data ?? [];
  const total = response?.total ?? 0;

  useEffect(() => {
    clampToTotal(total);
  }, [total, clampToTotal]);

  const deleteMutation = useMutation({
    mutationFn: api.removeImportListExclusion,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.importListExclusions() });
      toast.success('Exclusion removed');
    },
    onError: () => {
      toast.error('Failed to remove exclusion');
    },
  });

  const empty = EMPTY_STATE[kind];

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <div className="p-2 bg-primary/10 rounded-xl">
          <XCircleIcon className="w-5 h-5 text-primary" />
        </div>
        <div>
          <h2 className="font-display text-xl font-semibold">Import List Exclusions</h2>
          <p className="text-sm text-muted-foreground">Books your import lists won't add again</p>
        </div>
      </div>

      <Tabs
        tabs={KIND_TABS}
        value={kind}
        onChange={(value) => setKind(value as ImportListExclusionKind)}
        ariaLabel="Exclusion kind"
      />

      {isLoading ? (
        <div className="flex items-center justify-center py-12">
          <LoadingSpinner className="w-8 h-8 text-primary" />
        </div>
      ) : isError ? (
        // Ahead of the empty state on purpose: a failed read renders as `entries === []`, and
        // telling the operator nothing is excluded when the list could not be read is a lie.
        <div className="glass-card rounded-2xl p-8 sm:p-12 text-center">
          <p className="text-sm text-red-500">Failed to load exclusions.</p>
          <button
            type="button"
            onClick={() => { void refetch(); }}
            className="mt-4 px-3 py-1.5 text-sm border border-border rounded-lg hover:bg-muted transition-all focus-ring"
          >
            Retry
          </button>
        </div>
      ) : entries.length === 0 ? (
        <div className="glass-card rounded-2xl p-8 sm:p-12 text-center">
          <XCircleIcon className="w-12 h-12 text-muted-foreground/40 mx-auto mb-4" />
          <p className="text-lg font-medium">{empty.heading}</p>
          <p className="text-sm text-muted-foreground mt-1">{empty.detail}</p>
        </div>
      ) : (
        <div className="space-y-3">
          {entries.map((entry, index) => (
            <ImportListExclusionRow
              key={entry.id}
              entry={entry}
              index={index}
              onRemove={setDeleteTarget}
            />
          ))}
        </div>
      )}

      <Pagination
        page={pagination.page}
        totalPages={pagination.totalPages(total)}
        total={total}
        limit={pagination.limit}
        onPageChange={pagination.setPage}
      />

      <ConfirmModal
        isOpen={deleteTarget !== null}
        title="Remove Exclusion"
        message={deleteTarget
          ? `Remove the exclusion for "${deleteTarget.title}"? ${REMOVE_CONSEQUENCE[deleteTarget.kind]}`
          : ''}
        onConfirm={() => { if (deleteTarget) { deleteMutation.mutate(deleteTarget.id); setDeleteTarget(null); } }}
        onCancel={() => setDeleteTarget(null)}
      />
    </div>
  );
}
