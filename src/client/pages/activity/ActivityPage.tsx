import { useState, useEffect } from 'react';
import { useMutation } from '@tanstack/react-query';
import { toast } from 'sonner';
import {
  LoadingSpinner,
  ActivityIcon,
  HistoryIcon,
} from '@/components/icons';
import { EventHistorySection } from './EventHistorySection.js';
import { DownloadsTabSection } from './DownloadsTabSection.js';
import { useActivity } from './useActivity.js';
import { useMergeActivityCards } from '@/hooks/useMergeProgress.js';
import { useSearchProgress } from '@/hooks/useSearchProgress';
import { usePagination } from '@/hooks/usePagination';
import { api } from '@/lib/api';
import { DEFAULT_LIMITS } from '../../../shared/schemas/common.js';

export function ActivityPage() {
  const queuePagination = usePagination(DEFAULT_LIMITS.activity);
  const historyPagination = usePagination(DEFAULT_LIMITS.activity);
  const { clampToTotal: clampQueuePage } = queuePagination;
  const { clampToTotal: clampHistoryPage } = historyPagination;

  const { state, status, mutations } = useActivity(
    { limit: queuePagination.limit, offset: queuePagination.offset },
    { limit: historyPagination.limit, offset: historyPagination.offset },
  );
  const { queue, queueTotal, history, historyTotal } = state;
  const mergeCards = useMergeActivityCards();
  const searchCards = useSearchProgress();
  const { isLoading } = status;
  const { cancelMutation, retryMutation, approveMutation, rejectMutation, deleteMutation, deleteHistoryMutation } = mutations;

  const [cancellingMergeBookId, setCancellingMergeBookId] = useState<number | null>(null);
  const cancelMergeMutation = useMutation({
    mutationFn: (bookId: number) => api.cancelMergeBook(bookId),
    onMutate: (bookId) => setCancellingMergeBookId(bookId),
    onSuccess: () => setCancellingMergeBookId(null),
    onError: (error: Error) => {
      setCancellingMergeBookId(null);
      toast.error(`Cancel failed: ${error.message}`);
    },
  });

  // Clamp pages when totals shrink — use stable clampToTotal callbacks (destructured above)
  // instead of the full pagination objects to avoid re-running on every render.
  useEffect(() => { clampQueuePage(queueTotal); }, [queueTotal, clampQueuePage]);
  useEffect(() => { clampHistoryPage(historyTotal); }, [historyTotal, clampHistoryPage]);

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
            type="button"
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
            type="button"
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
        <DownloadsTabSection
          queue={queue}
          queueTotal={queueTotal}
          queuePagination={queuePagination}
          mergeCards={mergeCards}
          searchCards={searchCards}
          cancelMutation={cancelMutation}
          retryMutation={retryMutation}
          approveMutation={approveMutation}
          rejectMutation={rejectMutation}
          cancellingMergeBookId={cancellingMergeBookId}
          cancelMergeMutation={cancelMergeMutation}
          history={history}
          historyTotal={historyTotal}
          historyPagination={historyPagination}
          deleteMutation={deleteMutation}
          deleteHistoryMutation={deleteHistoryMutation}
          confirmClearHistory={confirmClearHistory}
          onConfirmClearHistoryChange={setConfirmClearHistory}
        />
      )}

      {tab === 'events' && (
        <div className="animate-fade-in-up stagger-2">
          <EventHistorySection />
        </div>
      )}
    </div>
  );
}
