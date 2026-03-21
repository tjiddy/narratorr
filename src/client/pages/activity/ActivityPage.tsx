import { useState, useEffect } from 'react';
import {
  LoadingSpinner,
  DownloadCloudIcon,
  HistoryIcon,
  ActivityIcon,
} from '@/components/icons';
import { DownloadCard } from './DownloadCard.js';
import { EventHistorySection } from './EventHistorySection.js';
import { useActivity } from './useActivity.js';
import { usePagination } from '@/hooks/usePagination';
import { Pagination } from '@/components/Pagination';
import { ConfirmModal } from '@/components/ConfirmModal';
import { DEFAULT_LIMITS } from '../../../shared/schemas/common.js';

// eslint-disable-next-line max-lines-per-function -- page with independent queue/history pagination sections
export function ActivityPage() {
  const queuePagination = usePagination(DEFAULT_LIMITS.activity);
  const historyPagination = usePagination(DEFAULT_LIMITS.activity);

  const {
    queue, queueTotal,
    history, historyTotal,
    isLoading,
    cancelMutation, retryMutation, approveMutation, rejectMutation,
    deleteMutation, deleteHistoryMutation,
  } = useActivity(
    { limit: queuePagination.limit, offset: queuePagination.offset },
    { limit: historyPagination.limit, offset: historyPagination.offset },
  );

  // Clamp pages when totals shrink
  useEffect(() => { queuePagination.clampToTotal(queueTotal); }, [queueTotal, queuePagination]);
  useEffect(() => { historyPagination.clampToTotal(historyTotal); }, [historyTotal, historyPagination]);

  const [tab, setTab] = useState<'downloads' | 'events'>('downloads');
  const [confirmClearHistory, setConfirmClearHistory] = useState(false);

  if (isLoading) {
    return (
      <div className="space-y-8">
        <div className="animate-fade-in-up">
          <h1 className="font-display text-3xl sm:text-4xl font-bold tracking-tight">
            Activity
          </h1>
          <p className="text-muted-foreground mt-2">
            Monitor your downloads and import history
          </p>
        </div>
        <div className="flex items-center justify-center py-24">
          <LoadingSpinner className="w-8 h-8 text-primary" />
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-10">
      {/* Header */}
      <div className="animate-fade-in-up">
        <h1 className="font-display text-3xl sm:text-4xl font-bold tracking-tight">
          Activity
        </h1>
        <p className="text-muted-foreground mt-2">
          Monitor your downloads and import history
        </p>
      </div>

      {/* Tab buttons */}
      <div className="flex justify-center animate-fade-in-up stagger-1">
        <div className="inline-flex items-center glass-card rounded-xl p-1 gap-1">
          <button
            onClick={() => setTab('downloads')}
            className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
              tab === 'downloads'
                ? 'bg-primary text-primary-foreground shadow-glow'
                : 'text-muted-foreground hover:text-foreground'
            }`}
          >
            <ActivityIcon className="w-4 h-4" />
            Downloads
          </button>
          <button
            onClick={() => setTab('events')}
            className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
              tab === 'events'
                ? 'bg-primary text-primary-foreground shadow-glow'
                : 'text-muted-foreground hover:text-foreground'
            }`}
          >
            <HistoryIcon className="w-4 h-4" />
            Event History
          </button>
        </div>
      </div>

      {tab === 'downloads' && (
        <>
          {/* Queue Section */}
          <section className="space-y-5 animate-fade-in-up stagger-2">
            <div className="flex items-center gap-3">
              <div className="p-2 bg-primary/10 rounded-xl">
                <DownloadCloudIcon className="w-5 h-5 text-primary" />
              </div>
              <div>
                <h2 className="font-display text-xl font-semibold">Queue</h2>
                <p className="text-sm text-muted-foreground">
                  {queueTotal} active download{queueTotal !== 1 ? 's' : ''}
                </p>
              </div>
            </div>

            {queue.length === 0 ? (
              <div className="glass-card rounded-2xl p-8 sm:p-12 text-center">
                <DownloadCloudIcon className="w-12 h-12 text-muted-foreground/40 mx-auto mb-4" />
                <p className="text-lg font-medium">No active downloads</p>
                <p className="text-sm text-muted-foreground mt-1">
                  Downloads will appear here when you grab audiobooks from search
                </p>
              </div>
            ) : (
              <div className="space-y-4">
                {queue.map((download, index) => (
                  <DownloadCard
                    key={download.id}
                    download={download}
                    onCancel={() => cancelMutation.mutate(download.id)}
                    onRetry={() => retryMutation.mutate(download.id)}
                    onApprove={() => approveMutation.mutate(download.id)}
                    onReject={() => rejectMutation.mutate(download.id)}
                    isCancelling={cancelMutation.isPending}
                    isApproving={approveMutation.isPending}
                    isRejecting={rejectMutation.isPending}
                    index={index}
                  />
                ))}
              </div>
            )}
            <Pagination
              page={queuePagination.page}
              totalPages={queuePagination.totalPages(queueTotal)}
              total={queueTotal}
              limit={queuePagination.limit}
              onPageChange={queuePagination.setPage}
            />
          </section>

          {/* Download History Section */}
          <section className="space-y-5 animate-fade-in-up stagger-3">
            <div className="flex items-center justify-between gap-3">
              <div className="flex items-center gap-3">
                <div className="p-2 bg-muted rounded-xl">
                  <HistoryIcon className="w-5 h-5 text-muted-foreground" />
                </div>
                <div>
                  <h2 className="font-display text-xl font-semibold">History</h2>
                  <p className="text-sm text-muted-foreground">
                    {historyTotal} completed download{historyTotal !== 1 ? 's' : ''}
                  </p>
                </div>
              </div>
              {historyTotal > 0 && (
                <button
                  type="button"
                  onClick={() => setConfirmClearHistory(true)}
                  className="flex items-center gap-1.5 px-3 py-2 text-sm font-medium text-muted-foreground hover:text-destructive hover:bg-destructive/10 rounded-xl transition-all focus-ring"
                >
                  Clear History
                </button>
              )}
            </div>

            {history.length === 0 ? (
              <div className="glass-card rounded-2xl p-8 sm:p-12 text-center">
                <HistoryIcon className="w-12 h-12 text-muted-foreground/40 mx-auto mb-4" />
                <p className="text-lg font-medium">No download history</p>
                <p className="text-sm text-muted-foreground mt-1">
                  Completed downloads will be listed here
                </p>
              </div>
            ) : (
              <div className="space-y-3">
                {history.map((download, index) => (
                  <DownloadCard
                    key={download.id}
                    download={download}
                    onRetry={() => retryMutation.mutate(download.id)}
                    onDelete={() => deleteMutation.mutate({ id: download.id, bookId: download.bookId })}
                    isDeleting={deleteMutation.isPending && deleteMutation.variables?.id === download.id}
                    showProgress={false}
                    index={index}
                    compact
                  />
                ))}
              </div>
            )}
            <Pagination
              page={historyPagination.page}
              totalPages={historyPagination.totalPages(historyTotal)}
              total={historyTotal}
              limit={historyPagination.limit}
              onPageChange={historyPagination.setPage}
            />
          </section>

          <ConfirmModal
            isOpen={confirmClearHistory}
            title="Clear Download History"
            message={`Remove all ${historyTotal} item${historyTotal !== 1 ? 's' : ''} from download history?`}
            confirmLabel="Delete"
            onConfirm={() => {
              deleteHistoryMutation.mutate(undefined, {
                onSettled: () => setConfirmClearHistory(false),
              });
            }}
            onCancel={() => setConfirmClearHistory(false)}
          />
        </>
      )}

      {tab === 'events' && (
        <div className="animate-fade-in-up stagger-2">
          <EventHistorySection />
        </div>
      )}
    </div>
  );
}
