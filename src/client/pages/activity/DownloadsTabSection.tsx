import type { UseMutationResult } from '@tanstack/react-query';
import {
  DownloadCloudIcon,
  HistoryIcon,
} from '@/components/icons';
import { DownloadCard } from './DownloadCard.js';
import { MergeCard } from './MergeCard.js';
import { SearchCard } from './SearchCard.js';
import { Pagination } from '@/components/Pagination';
import { ConfirmModal } from '@/components/ConfirmModal';
import type { usePagination } from '@/hooks/usePagination';
import type { useMergeActivityCards } from '@/hooks/useMergeProgress';
import type { useSearchProgress } from '@/hooks/useSearchProgress';
import type { Download } from '@/lib/api';

export interface DownloadsTabSectionProps {
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
  history: Download[];
  historyTotal: number;
  historyPagination: ReturnType<typeof usePagination>;
  deleteMutation: UseMutationResult<unknown, Error, { id: number; bookId?: number | null }>;
  deleteHistoryMutation: UseMutationResult<unknown, Error, void>;
  confirmClearHistory: boolean;
  onConfirmClearHistoryChange: (open: boolean) => void;
}

export function DownloadsTabSection(props: DownloadsTabSectionProps) {
  const { queue, queueTotal, queuePagination, mergeCards, searchCards, cancelMutation, retryMutation, approveMutation, rejectMutation, cancellingMergeBookId, cancelMergeMutation } = props;

  return (
    <>
      {/* Active Downloads Section */}
      <section className="space-y-5 animate-fade-in-up stagger-2">
        <div className="flex items-center gap-3">
          <div className="p-2 bg-primary/10 rounded-xl">
            <DownloadCloudIcon className="w-5 h-5 text-primary" />
          </div>
          <div>
            <h2 className="font-display text-xl font-semibold">Active</h2>
            <p className="text-sm text-muted-foreground">
              {queueTotal} active download{queueTotal !== 1 ? 's' : ''}
            </p>
          </div>
        </div>

        {mergeCards.length > 0 && (
          <div className="space-y-4">
            {mergeCards.map((card) => (
              <MergeCard key={card.bookId} state={card} onCancel={(bookId) => cancelMergeMutation.mutate(bookId)} isCancelling={cancellingMergeBookId === card.bookId} />
            ))}
          </div>
        )}

        {searchCards.length > 0 && (
          <div className="space-y-4">
            {searchCards.map((card) => (<SearchCard key={card.bookId} state={card} />))}
          </div>
        )}

        {queue.length === 0 && searchCards.length === 0 && mergeCards.length === 0 ? (
          <div className="glass-card rounded-2xl p-8 sm:p-12 text-center">
            <DownloadCloudIcon className="w-12 h-12 text-muted-foreground/40 mx-auto mb-4" />
            <p className="text-lg font-medium">No active downloads</p>
            <p className="text-sm text-muted-foreground mt-1">Downloads will appear here when you grab audiobooks from search</p>
          </div>
        ) : queue.length > 0 ? (
          <div className="space-y-4">
            {queue.map((download, index) => (
              <DownloadCard
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

      <DownloadHistorySection {...props} />
    </>
  );
}

function DownloadHistorySection({ history, historyTotal, historyPagination, retryMutation, deleteMutation, deleteHistoryMutation, confirmClearHistory, onConfirmClearHistoryChange }: DownloadsTabSectionProps) {
  return (
    <>
      <section className="space-y-5 animate-fade-in-up stagger-3">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <div className="p-2 bg-muted rounded-xl">
              <HistoryIcon className="w-5 h-5 text-muted-foreground" />
            </div>
            <div>
              <h2 className="font-display text-xl font-semibold">History</h2>
              <p className="text-sm text-muted-foreground">{historyTotal} completed download{historyTotal !== 1 ? 's' : ''}</p>
            </div>
          </div>
          {historyTotal > 0 && (
            <button type="button" onClick={() => onConfirmClearHistoryChange(true)} className="flex items-center gap-1.5 px-3 py-2 text-sm font-medium text-muted-foreground hover:text-destructive hover:bg-destructive/10 rounded-xl transition-all focus-ring">
              Clear History
            </button>
          )}
        </div>

        {history.length === 0 ? (
          <div className="glass-card rounded-2xl p-8 sm:p-12 text-center">
            <HistoryIcon className="w-12 h-12 text-muted-foreground/40 mx-auto mb-4" />
            <p className="text-lg font-medium">No download history</p>
            <p className="text-sm text-muted-foreground mt-1">Completed downloads will be listed here</p>
          </div>
        ) : (
          <div className="space-y-3">
            {history.map((download, index) => (
              <DownloadCard key={download.id} download={download} onRetry={() => retryMutation.mutate(download.id)} onDelete={() => deleteMutation.mutate({ id: download.id, bookId: download.bookId })} isDeleting={deleteMutation.isPending && deleteMutation.variables?.id === download.id} isRetrying={retryMutation.isPending && retryMutation.variables === download.id} showProgress={false} index={index} compact />
            ))}
          </div>
        )}
        <Pagination page={historyPagination.page} totalPages={historyPagination.totalPages(historyTotal)} total={historyTotal} limit={historyPagination.limit} onPageChange={historyPagination.setPage} />
      </section>

      <ConfirmModal
        isOpen={confirmClearHistory}
        title="Clear Download History"
        message={`Remove all ${historyTotal} item${historyTotal !== 1 ? 's' : ''} from download history?`}
        confirmLabel="Delete"
        onConfirm={() => { deleteHistoryMutation.mutate(undefined, { onSettled: () => onConfirmClearHistoryChange(false) }); }}
        onCancel={() => onConfirmClearHistoryChange(false)}
      />
    </>
  );
}
