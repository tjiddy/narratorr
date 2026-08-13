import { useState, useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { api, type ImportListExclusion } from '@/lib/api';
import { queryKeys } from '@/lib/queryKeys';
import { ConfirmModal } from '@/components/ConfirmModal';
import { Pagination } from '@/components/Pagination';
import { usePagination } from '@/hooks/usePagination';
import { DEFAULT_LIMITS } from '@shared/schemas/common.js';
import { LoadingSpinner, XCircleIcon } from '@/components/icons';
import { ImportListExclusionRow } from './ImportListExclusionRow';

export function ImportListExclusionsSettings() {
  const queryClient = useQueryClient();
  const [deleteTarget, setDeleteTarget] = useState<ImportListExclusion | null>(null);
  const pagination = usePagination(DEFAULT_LIMITS.importListExclusions);
  const { clampToTotal } = pagination;

  const paginationParams = { limit: pagination.limit, offset: pagination.offset };
  const { data: response, isLoading, isError, refetch } = useQuery({
    queryKey: queryKeys.importListExclusions(paginationParams),
    queryFn: () => api.getImportListExclusions(paginationParams),
    placeholderData: (previousData) => previousData,
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
          <p className="text-lg font-medium">No exclusions</p>
          <p className="text-sm text-muted-foreground mt-1">
            Deleting a book that an import list added excludes it, so the list won't add it back
          </p>
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
        message={`Remove the exclusion for "${deleteTarget?.title}"? An import list may add it again on its next sync.`}
        onConfirm={() => { if (deleteTarget) { deleteMutation.mutate(deleteTarget.id); setDeleteTarget(null); } }}
        onCancel={() => setDeleteTarget(null)}
      />
    </div>
  );
}
