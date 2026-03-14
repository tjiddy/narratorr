import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { api, type BlacklistEntry } from '@/lib/api';
import { queryKeys } from '@/lib/queryKeys';
import { ConfirmModal } from '@/components/ConfirmModal';
import {
  LoadingSpinner,
  ShieldBanIcon,
  TrashIcon,
} from '@/components/icons';

const REASON_LABELS: Record<string, string> = {
  wrong_content: 'Wrong Content',
  bad_quality: 'Bad Quality',
  wrong_narrator: 'Wrong Narrator',
  spam: 'Spam',
  other: 'Other',
  download_failed: 'Download Failed',
  infrastructure_error: 'Infrastructure Error',
};

function formatExpiry(entry: BlacklistEntry): string {
  if (entry.blacklistType === 'permanent' || !entry.expiresAt) {
    return 'Permanent';
  }
  const expiresAt = new Date(entry.expiresAt);
  const now = new Date();
  const diffMs = expiresAt.getTime() - now.getTime();
  if (diffMs <= 0) return 'Expired';
  const diffDays = Math.ceil(diffMs / (1000 * 60 * 60 * 24));
  if (diffDays === 1) return 'Expires in 1 day';
  return `Expires in ${diffDays} days`;
}

export function BlacklistSettings() {
  const queryClient = useQueryClient();
  const [deleteTarget, setDeleteTarget] = useState<BlacklistEntry | null>(null);

  const { data: entries = [], isLoading } = useQuery({
    queryKey: queryKeys.blacklist(),
    queryFn: api.getBlacklist,
    select: (response) => response.data,
  });

  const deleteMutation = useMutation({
    mutationFn: api.removeFromBlacklist,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.blacklist() });
      toast.success('Removed from blacklist');
    },
    onError: () => {
      toast.error('Failed to remove from blacklist');
    },
  });

  const toggleMutation = useMutation({
    mutationFn: ({ id, blacklistType }: { id: number; blacklistType: 'temporary' | 'permanent' }) =>
      api.toggleBlacklistType(id, blacklistType),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.blacklist() });
      toast.success('Blacklist entry updated');
    },
    onError: () => {
      toast.error('Failed to update blacklist entry');
    },
  });

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center gap-3">
        <div className="p-2 bg-primary/10 rounded-xl">
          <ShieldBanIcon className="w-5 h-5 text-primary" />
        </div>
        <div>
          <h2 className="font-display text-xl font-semibold">Blacklist</h2>
          <p className="text-sm text-muted-foreground">Releases that won't appear in search results</p>
        </div>
      </div>

      {/* List */}
      {isLoading ? (
        <div className="flex items-center justify-center py-12">
          <LoadingSpinner className="w-8 h-8 text-primary" />
        </div>
      ) : entries.length === 0 ? (
        <div className="glass-card rounded-2xl p-8 sm:p-12 text-center">
          <ShieldBanIcon className="w-12 h-12 text-muted-foreground/40 mx-auto mb-4" />
          <p className="text-lg font-medium">No blacklisted releases</p>
          <p className="text-sm text-muted-foreground mt-1">
            Blacklist releases from the search modal to prevent them from appearing again
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
                    <span className="text-xs px-2 py-0.5 bg-muted rounded-md font-medium text-muted-foreground">
                      {entry.reason ? (REASON_LABELS[entry.reason] ?? entry.reason) : 'Unknown'}
                    </span>
                    <span className={`text-xs px-2 py-0.5 rounded-md font-medium ${
                      entry.blacklistType === 'temporary'
                        ? 'bg-amber-500/10 text-amber-600 dark:text-amber-400'
                        : 'bg-muted text-muted-foreground'
                    }`}>
                      {formatExpiry(entry)}
                    </span>
                    <span className="text-xs text-muted-foreground font-mono">
                      {entry.infoHash.slice(0, 12)}...
                    </span>
                    <span className="text-xs text-muted-foreground">
                      {new Date(entry.blacklistedAt).toLocaleDateString()}
                    </span>
                  </div>
                  {entry.note && (
                    <p className="text-xs text-muted-foreground mt-1.5">{entry.note}</p>
                  )}
                </div>
                <div className="flex items-center gap-1 shrink-0">
                  <button
                    type="button"
                    onClick={() => toggleMutation.mutate({
                      id: entry.id,
                      blacklistType: entry.blacklistType === 'temporary' ? 'permanent' : 'temporary',
                    })}
                    className="px-2 py-1.5 rounded-lg text-xs font-medium text-muted-foreground hover:text-foreground hover:bg-muted/50 transition-colors focus-ring"
                    aria-label={`Toggle ${entry.title} to ${entry.blacklistType === 'temporary' ? 'permanent' : 'temporary'}`}
                  >
                    {entry.blacklistType === 'temporary' ? 'Make Permanent' : 'Make Temporary'}
                  </button>
                  <button
                    type="button"
                    onClick={() => setDeleteTarget(entry)}
                    className="p-2 rounded-lg text-muted-foreground hover:text-destructive hover:bg-destructive/10 transition-colors focus-ring shrink-0"
                    aria-label={`Remove ${entry.title} from blacklist`}
                  >
                    <TrashIcon className="w-4 h-4" />
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      <ConfirmModal
        isOpen={deleteTarget !== null}
        title="Remove from Blacklist"
        message={`Remove "${deleteTarget?.title}" from the blacklist? This release will appear in search results again.`}
        onConfirm={() => { if (deleteTarget) { deleteMutation.mutate(deleteTarget.id); setDeleteTarget(null); } }}
        onCancel={() => setDeleteTarget(null)}
      />
    </div>
  );
}
