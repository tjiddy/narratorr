import { useState, useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { api, type ImportListExclusion } from '@/lib/api';
import { queryKeys } from '@/lib/queryKeys';
import { ConfirmModal } from '@/components/ConfirmModal';
import { Pagination } from '@/components/Pagination';
import { usePagination } from '@/hooks/usePagination';
import { DEFAULT_LIMITS } from '@shared/schemas/common.js';
import { LoadingSpinner, XCircleIcon, TrashIcon } from '@/components/icons';

export function ImportListExclusionsSettings() {
  const queryClient = useQueryClient();
  const [deleteTarget, setDeleteTarget] = useState<ImportListExclusion | null>(null);
  const pagination = usePagination(DEFAULT_LIMITS.importListExclusions);
  const { clampToTotal } = pagination;

  const paginationParams = { limit: pagination.limit, offset: pagination.offset };
  const { data: response, isLoading } = useQuery({
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
            <div
              key={entry.id}
              className="glass-card rounded-xl p-4 animate-fade-in-up"
              style={{ animationDelay: `${index * 50}ms` }}
            >
              <div className="flex items-start justify-between gap-4">
                <div className="min-w-0 flex-1">
                  <h3 className="font-medium text-sm truncate">{entry.title}</h3>
                  <div className="flex flex-wrap items-center gap-2 mt-1.5">
                    {entry.authorName && (
                      <span className="text-xs text-muted-foreground">{entry.authorName}</span>
                    )}
                    <span className="text-xs px-2 py-0.5 bg-muted rounded-md font-medium text-muted-foreground">
                      {entry.importListName ?? 'Unknown list'}
                    </span>
                    {entry.asin && (
                      <span className="text-xs text-muted-foreground font-mono">{entry.asin}</span>
                    )}
                    <span className="text-xs text-muted-foreground">
                      {new Date(entry.createdAt).toLocaleDateString()}
                    </span>
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => setDeleteTarget(entry)}
                  className="p-2 rounded-lg text-muted-foreground hover:text-destructive hover:bg-destructive/10 transition-colors focus-ring shrink-0"
                  aria-label={`Remove exclusion for ${entry.title}`}
                >
                  <TrashIcon className="w-4 h-4" />
                </button>
              </div>
            </div>
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
