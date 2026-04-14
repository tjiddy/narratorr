import { useState, useEffect } from 'react';
import { useMutation } from '@tanstack/react-query';
import { toast } from 'sonner';
import {
  LoadingSpinner,
  ActivityIcon,
  HistoryIcon,
} from '@/components/icons';
import { PageHeader } from '@/components/PageHeader.js';
import { Tabs, type TabItem } from '@/components/Tabs.js';
import { EventHistorySection } from './EventHistorySection.js';
import { DownloadsTabSection } from './DownloadsTabSection.js';
import { useActivity } from './useActivity.js';
import { useMergeActivityCards } from '@/hooks/useMergeProgress.js';
import { useSearchProgress } from '@/hooks/useSearchProgress';
import { usePagination } from '@/hooks/usePagination';
import { api } from '@/lib/api';
import { getErrorMessage } from '@/lib/error-message.js';
import { DEFAULT_LIMITS } from '../../../shared/schemas/common.js';

const ACTIVITY_TABS: TabItem[] = [
  { value: 'active', label: 'Active', icon: <ActivityIcon className="w-4 h-4" /> },
  { value: 'history', label: 'History', icon: <HistoryIcon className="w-4 h-4" /> },
];

export function ActivityPage() {
  const queuePagination = usePagination(DEFAULT_LIMITS.activity);
  const { clampToTotal: clampQueuePage } = queuePagination;

  const { state, status, mutations } = useActivity(
    { limit: queuePagination.limit, offset: queuePagination.offset },
  );
  const { queue, queueTotal } = state;
  const mergeCards = useMergeActivityCards();
  const searchCards = useSearchProgress();
  const { isLoading } = status;
  const { cancelMutation, retryMutation, approveMutation, rejectMutation } = mutations;

  const [cancellingMergeBookId, setCancellingMergeBookId] = useState<number | null>(null);
  const cancelMergeMutation = useMutation({
    mutationFn: (bookId: number) => api.cancelMergeBook(bookId),
    onMutate: (bookId) => setCancellingMergeBookId(bookId),
    onSuccess: () => setCancellingMergeBookId(null),
    onError: (error: Error) => {
      setCancellingMergeBookId(null);
      toast.error(`Cancel failed: ${getErrorMessage(error)}`);
    },
  });

  // Clamp page when total shrinks — use stable clampToTotal callback (destructured above)
  // instead of the full pagination object to avoid re-running on every render.
  useEffect(() => { clampQueuePage(queueTotal); }, [queueTotal, clampQueuePage]);

  const [tab, setTab] = useState<'active' | 'history'>('active');

  if (isLoading) {
    return (
      <div className="space-y-8">
        <PageHeader title="Activity" subtitle="Monitor your downloads and import history" />
        <div className="flex items-center justify-center py-24">
          <LoadingSpinner className="w-8 h-8 text-primary" />
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-10">
      {/* Header */}
      <PageHeader title="Activity" subtitle="Monitor your downloads and import history" />

      {/* Tab buttons */}
      <div className="flex justify-center animate-fade-in-up stagger-1">
        <Tabs tabs={ACTIVITY_TABS} value={tab} onChange={(v) => setTab(v as 'active' | 'history')} ariaLabel="Activity" />
      </div>

      {tab === 'active' && (
        <div role="tabpanel" id="tabpanel-active" aria-labelledby="tab-active">
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
        />
        </div>
      )}

      {tab === 'history' && (
        <div role="tabpanel" id="tabpanel-history" aria-labelledby="tab-history" className="animate-fade-in-up stagger-2">
          <EventHistorySection />
        </div>
      )}
    </div>
  );
}
