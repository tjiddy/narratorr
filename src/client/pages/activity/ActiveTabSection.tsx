import type { UseMutationResult } from '@tanstack/react-query';
import {
  DownloadCloudIcon,
} from '@/components/icons';
import { DownloadActivityCard } from './DownloadActivityCard.js';
import { MergeActivityCard } from './MergeActivityCard.js';
import { SearchActivityCard } from './SearchActivityCard.js';
import { Pagination } from '@/components/Pagination';
import type { usePagination } from '@/hooks/usePagination';
import type { useMergeActivityCards } from '@/hooks/useMergeProgress';
import type { useSearchProgress } from '@/hooks/useSearchProgress';
import type { Download } from '@/lib/api';

export interface ActiveTabSectionProps {
  queue: Download[];
  queueTotal: number;
  queuePagination: ReturnType<typeof usePagination>;
  mergeCards: ReturnType<typeof useMergeActivityCards>;
  searchCards: ReturnType<typeof useSearchProgress>;
  cancelMutation: UseMutationResult<unknown, Error, number>;
  retryMutation: UseMutationResult<unknown, Error, number>;
  approveMutation: UseMutationResult<unknown, Error, number>;
  rejectMutation: UseMutationResult<unknown, Error, { id: number; retry?: boolean }>;
  cancellingMergeBookId: number | null;
  cancelMergeMutation: UseMutationResult<unknown, Error, number>;
}

export function ActiveTabSection(props: ActiveTabSectionProps) {
  const { queue, queueTotal, queuePagination, mergeCards, searchCards, cancelMutation, retryMutation, approveMutation, rejectMutation, cancellingMergeBookId, cancelMergeMutation } = props;

  return (
    <section className="space-y-5 animate-fade-in-up stagger-2">
      <div className="flex items-center gap-3">
        <div className="p-2 bg-primary/10 rounded-xl">
          <DownloadCloudIcon className="w-5 h-5 text-primary" />
        </div>
        <div>
          <h2 className="font-display text-xl font-semibold">Active</h2>
          <p className="text-sm text-muted-foreground">
            {queueTotal} in queue
          </p>
        </div>
      </div>

      {mergeCards.length > 0 && (
        <div className="space-y-4">
          {mergeCards.map((card) => (
            <MergeActivityCard key={card.bookId} state={card} onCancel={(bookId) => cancelMergeMutation.mutate(bookId)} isCancelling={cancellingMergeBookId === card.bookId} />
          ))}
        </div>
      )}

      {searchCards.length > 0 && (
        <div className="space-y-4">
          {searchCards.map((card) => (<SearchActivityCard key={card.bookId} state={card} />))}
        </div>
      )}

      {queue.length === 0 && searchCards.length === 0 && mergeCards.length === 0 ? (
        <div className="glass-card rounded-2xl p-8 sm:p-12 text-center">
          <DownloadCloudIcon className="w-12 h-12 text-muted-foreground/40 mx-auto mb-4" />
          <p className="text-lg font-medium">Nothing running right now</p>
          <p className="text-sm text-muted-foreground mt-1">Activity will appear here when you search, grab, or merge audiobooks</p>
        </div>
      ) : queue.length > 0 ? (
        <div className="space-y-4">
          {queue.map((download, index) => (
            <DownloadActivityCard
              key={download.id}
              download={download}
              onCancel={() => cancelMutation.mutate(download.id)}
              onRetry={() => retryMutation.mutate(download.id)}
              onApprove={() => approveMutation.mutate(download.id)}
              onReject={() => rejectMutation.mutate({ id: download.id, retry: false })}
              onRejectWithSearch={() => rejectMutation.mutate({ id: download.id, retry: true })}
              isCancelling={cancelMutation.isPending && cancelMutation.variables === download.id}
              isApproving={approveMutation.isPending}
              isRejectingDismiss={rejectMutation.isPending && rejectMutation.variables?.id === download.id && !rejectMutation.variables?.retry}
              isRejectingWithSearch={rejectMutation.isPending && rejectMutation.variables?.id === download.id && !!rejectMutation.variables?.retry}
              isRetrying={retryMutation.isPending && retryMutation.variables === download.id}
              index={index}
            />
          ))}
        </div>
      ) : null}
      <Pagination page={queuePagination.page} totalPages={queuePagination.totalPages(queueTotal)} total={queueTotal} limit={queuePagination.limit} onPageChange={queuePagination.setPage} />
    </section>
  );
}
