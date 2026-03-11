import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { api } from '@/lib/api';
import type { RecyclingBinEntry } from '@/lib/api';
import { queryKeys } from '@/lib/queryKeys';
import { LoadingSpinner, TrashIcon, RefreshIcon } from '@/components/icons';
import { ConfirmModal } from '@/components/ConfirmModal';
import { SettingsSection } from './SettingsSection';

function formatDeletedDate(dateStr: string): string {
  const date = new Date(dateStr);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

  if (diffDays === 0) return 'Today';
  if (diffDays === 1) return 'Yesterday';
  if (diffDays < 30) return `${diffDays} days ago`;
  return date.toLocaleDateString();
}

export function RecyclingBinSection() {
  const queryClient = useQueryClient();
  const [purgeId, setPurgeId] = useState<number | null>(null);
  const [emptyAllOpen, setEmptyAllOpen] = useState(false);

  const { data: entries = [], isLoading } = useQuery({
    queryKey: queryKeys.recyclingBin(),
    queryFn: api.getRecyclingBinEntries,
  });

  const restoreMutation = useMutation({
    mutationFn: (id: number) => api.restoreRecyclingBinEntry(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.recyclingBin() });
      queryClient.invalidateQueries({ queryKey: queryKeys.books() });
      toast.success('Book restored from recycling bin');
    },
    onError: (err) => {
      toast.error(err instanceof Error ? err.message : 'Failed to restore');
    },
  });

  const purgeMutation = useMutation({
    mutationFn: (id: number) => api.purgeRecyclingBinEntry(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.recyclingBin() });
      toast.success('Permanently deleted');
      setPurgeId(null);
    },
    onError: (err) => {
      toast.error(err instanceof Error ? err.message : 'Failed to delete');
      setPurgeId(null);
    },
  });

  const emptyAllMutation = useMutation({
    mutationFn: api.emptyRecyclingBin,
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.recyclingBin() });
      if (result.failed > 0) {
        toast.warning(`Emptied ${result.purged} items, ${result.failed} failed`);
      } else {
        toast.success(`Emptied ${result.purged} items from recycling bin`);
      }
      setEmptyAllOpen(false);
    },
    onError: (err) => {
      toast.error(err instanceof Error ? err.message : 'Failed to empty recycling bin');
      setEmptyAllOpen(false);
    },
  });

  return (
    <SettingsSection
      icon={<TrashIcon className="w-5 h-5 text-primary" />}
      title="Recycling Bin"
      description="Deleted audiobooks are kept here for recovery before permanent deletion."
    >
      <div className="flex items-center justify-between">
        {entries.length > 0 && (
          <span className="text-xs font-medium text-muted-foreground tracking-wider uppercase">
            {entries.length} {entries.length === 1 ? 'item' : 'items'}
          </span>
        )}
        <div className="ml-auto">
          <button
            type="button"
            onClick={() => setEmptyAllOpen(true)}
            disabled={entries.length === 0 || emptyAllMutation.isPending}
            className="flex items-center gap-2 px-4 py-2 text-sm font-medium text-destructive border border-destructive/30 rounded-xl hover:bg-destructive/10 disabled:opacity-50 transition-all focus-ring"
          >
            {emptyAllMutation.isPending ? <LoadingSpinner className="w-4 h-4" /> : <TrashIcon className="w-4 h-4" />}
            Empty All
          </button>
        </div>
      </div>

      {isLoading ? (
        <div className="flex justify-center py-8">
          <LoadingSpinner className="w-6 h-6" />
        </div>
      ) : entries.length === 0 ? (
        <div className="flex flex-col items-center py-10 text-muted-foreground">
          <TrashIcon className="w-8 h-8 mb-3 opacity-40" />
          <p>Recycling bin is empty</p>
        </div>
      ) : (
        <div className="space-y-2 animate-fade-in">
          {entries.map((entry: RecyclingBinEntry, i: number) => (
            <div
              key={entry.id}
              className={`group flex items-center justify-between gap-4 p-4 rounded-xl border border-border/60 hover:border-border hover:bg-muted/30 transition-colors ${i < 8 ? `stagger-${i + 1}` : ''}`}
            >
              <div className="min-w-0">
                <p className="font-medium truncate">{entry.title}</p>
                <p className="text-sm text-muted-foreground truncate">
                  {entry.authorName && <span>{entry.authorName} &middot; </span>}
                  Deleted {formatDeletedDate(entry.deletedAt)}
                </p>
              </div>
              <div className="flex items-center gap-1 shrink-0 sm:opacity-0 sm:group-hover:opacity-100 transition-opacity">
                <button
                  type="button"
                  onClick={() => restoreMutation.mutate(entry.id)}
                  disabled={restoreMutation.isPending}
                  className="flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium rounded-lg hover:text-primary hover:bg-primary/10 transition-colors focus-ring"
                  title="Restore"
                >
                  {restoreMutation.isPending ? <LoadingSpinner className="w-3.5 h-3.5" /> : <RefreshIcon className="w-3.5 h-3.5" />}
                  Restore
                </button>
                <button
                  type="button"
                  onClick={() => setPurgeId(entry.id)}
                  disabled={purgeMutation.isPending}
                  className="flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium text-destructive rounded-lg hover:bg-destructive/10 transition-colors focus-ring"
                  title="Delete permanently"
                >
                  <TrashIcon className="w-3.5 h-3.5" />
                  Delete
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      <ConfirmModal
        isOpen={purgeId !== null}
        title="Permanently Delete"
        message="This will permanently delete the files. This action cannot be undone."
        confirmLabel="Delete Permanently"
        onConfirm={() => purgeId !== null && purgeMutation.mutate(purgeId)}
        onCancel={() => setPurgeId(null)}
      />

      <ConfirmModal
        isOpen={emptyAllOpen}
        title="Empty Recycling Bin"
        message={`This will permanently delete all ${entries.length} items. This action cannot be undone.`}
        confirmLabel="Empty All"
        onConfirm={() => emptyAllMutation.mutate()}
        onCancel={() => setEmptyAllOpen(false)}
      />
    </SettingsSection>
  );
}
