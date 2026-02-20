import {
  LoadingSpinner,
  DownloadCloudIcon,
  HistoryIcon,
} from '@/components/icons';
import { DownloadCard } from './DownloadCard.js';
import { useActivity } from './useActivity.js';

export function ActivityPage() {
  const { queue, history, isLoading, cancelMutation, retryMutation } = useActivity();

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

      {/* Queue Section */}
      <section className="space-y-5 animate-fade-in-up stagger-1">
        <div className="flex items-center gap-3">
          <div className="p-2 bg-primary/10 rounded-xl">
            <DownloadCloudIcon className="w-5 h-5 text-primary" />
          </div>
          <div>
            <h2 className="font-display text-xl font-semibold">Queue</h2>
            <p className="text-sm text-muted-foreground">
              {queue.length} active download{queue.length !== 1 ? 's' : ''}
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
                isCancelling={cancelMutation.isPending}
                index={index}
              />
            ))}
          </div>
        )}
      </section>

      {/* History Section */}
      <section className="space-y-5 animate-fade-in-up stagger-2">
        <div className="flex items-center gap-3">
          <div className="p-2 bg-muted rounded-xl">
            <HistoryIcon className="w-5 h-5 text-muted-foreground" />
          </div>
          <div>
            <h2 className="font-display text-xl font-semibold">History</h2>
            <p className="text-sm text-muted-foreground">
              {history.length} completed download{history.length !== 1 ? 's' : ''}
            </p>
          </div>
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
                showProgress={false}
                index={index}
                compact
              />
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
