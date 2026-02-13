import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api, formatBytes, formatProgress, type Download } from '@/lib/api';
import { queryKeys } from '@/lib/queryKeys';

function LoadingSpinner({ className = '' }: { className?: string }) {
  return (
    <svg
      className={`animate-spin ${className}`}
      xmlns="http://www.w3.org/2000/svg"
      fill="none"
      viewBox="0 0 24 24"
    >
      <circle
        className="opacity-25"
        cx="12"
        cy="12"
        r="10"
        stroke="currentColor"
        strokeWidth="4"
      />
      <path
        className="opacity-75"
        fill="currentColor"
        d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
      />
    </svg>
  );
}

function DownloadCloudIcon({ className = '' }: { className?: string }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
    >
      <path d="M4 14.899A7 7 0 1 1 15.71 8h1.79a4.5 4.5 0 0 1 2.5 8.242" />
      <path d="M12 12v9" />
      <path d="m8 17 4 4 4-4" />
    </svg>
  );
}

function HistoryIcon({ className = '' }: { className?: string }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
    >
      <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
      <path d="M3 3v5h5" />
      <path d="M12 7v5l4 2" />
    </svg>
  );
}

function XCircleIcon({ className = '' }: { className?: string }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
    >
      <circle cx="12" cy="12" r="10" />
      <path d="m15 9-6 6" />
      <path d="m9 9 6 6" />
    </svg>
  );
}

function RefreshCwIcon({ className = '' }: { className?: string }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
    >
      <path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8" />
      <path d="M21 3v5h-5" />
      <path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16" />
      <path d="M8 16H3v5" />
    </svg>
  );
}

function ClockIcon({ className = '' }: { className?: string }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
    >
      <circle cx="12" cy="12" r="10" />
      <polyline points="12 6 12 12 16 14" />
    </svg>
  );
}

function ArrowDownIcon({ className = '' }: { className?: string }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
    >
      <path d="M12 5v14" />
      <path d="m19 12-7 7-7-7" />
    </svg>
  );
}

function CheckCircleIcon({ className = '' }: { className?: string }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
    >
      <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" />
      <polyline points="22 4 12 14.01 9 11.01" />
    </svg>
  );
}

function PackageIcon({ className = '' }: { className?: string }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
    >
      <path d="m7.5 4.27 9 5.15" />
      <path d="M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z" />
      <path d="m3.3 7 8.7 5 8.7-5" />
      <path d="M12 22V12" />
    </svg>
  );
}

function AlertCircleIcon({ className = '' }: { className?: string }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
    >
      <circle cx="12" cy="12" r="10" />
      <line x1="12" x2="12" y1="8" y2="12" />
      <line x1="12" x2="12.01" y1="16" y2="16" />
    </svg>
  );
}

function PauseIcon({ className = '' }: { className?: string }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
    >
      <rect width="4" height="16" x="6" y="4" />
      <rect width="4" height="16" x="14" y="4" />
    </svg>
  );
}

const statusConfig: Record<
  string,
  {
    icon: React.FC<{ className?: string }>;
    label: string;
    color: string;
    bgColor: string;
    textColor: string;
  }
> = {
  queued: {
    icon: ClockIcon,
    label: 'Queued',
    color: 'text-amber-500',
    bgColor: 'bg-amber-500/10',
    textColor: 'text-amber-600 dark:text-amber-400',
  },
  downloading: {
    icon: ArrowDownIcon,
    label: 'Downloading',
    color: 'text-blue-500',
    bgColor: 'bg-blue-500/10',
    textColor: 'text-blue-600 dark:text-blue-400',
  },
  paused: {
    icon: PauseIcon,
    label: 'Paused',
    color: 'text-muted-foreground',
    bgColor: 'bg-muted',
    textColor: 'text-muted-foreground',
  },
  completed: {
    icon: CheckCircleIcon,
    label: 'Completed',
    color: 'text-success',
    bgColor: 'bg-success/10',
    textColor: 'text-success',
  },
  importing: {
    icon: PackageIcon,
    label: 'Importing',
    color: 'text-violet-500',
    bgColor: 'bg-violet-500/10',
    textColor: 'text-violet-600 dark:text-violet-400',
  },
  imported: {
    icon: CheckCircleIcon,
    label: 'Imported',
    color: 'text-success',
    bgColor: 'bg-success/10',
    textColor: 'text-success',
  },
  failed: {
    icon: AlertCircleIcon,
    label: 'Failed',
    color: 'text-destructive',
    bgColor: 'bg-destructive/10',
    textColor: 'text-destructive',
  },
};

export function ActivityPage() {
  const queryClient = useQueryClient();

  const { data: downloads = [], isLoading } = useQuery({
    queryKey: queryKeys.activity(),
    queryFn: api.getActivity,
    refetchInterval: (query) => {
      const data = query.state.data;
      if (!data) return 5000;
      return data.some((d: Download) => ['queued', 'downloading', 'importing'].includes(d.status)) ? 5000 : false;
    },
  });

  const cancelMutation = useMutation({
    mutationFn: api.cancelDownload,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.activity() });
    },
  });

  const retryMutation = useMutation({
    mutationFn: api.retryDownload,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.activity() });
    },
  });

  const queue = downloads.filter((d) =>
    ['queued', 'downloading', 'paused', 'importing'].includes(d.status)
  );
  const history = downloads.filter((d) =>
    ['completed', 'imported', 'failed'].includes(d.status)
  );

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

function DownloadCard({
  download,
  onCancel,
  onRetry,
  isCancelling,
  showProgress = true,
  index = 0,
  compact = false,
}: {
  download: Download;
  onCancel?: () => void;
  onRetry?: () => void;
  isCancelling?: boolean;
  showProgress?: boolean;
  index?: number;
  compact?: boolean;
}) {
  const config = statusConfig[download.status] || statusConfig.queued;
  const StatusIcon = config.icon;

  return (
    <div
      className={`
        glass-card rounded-2xl overflow-hidden
        hover:border-primary/20 transition-all duration-300
        animate-fade-in-up
        ${compact ? 'p-4' : 'p-5'}
      `}
      style={{ animationDelay: `${index * 50}ms` }}
    >
      <div className="flex flex-col sm:flex-row sm:items-start gap-4">
        {/* Status Icon */}
        <div className={`shrink-0 p-2.5 rounded-xl ${config.bgColor}`}>
          <StatusIcon className={`w-5 h-5 ${config.color}`} />
        </div>

        {/* Content */}
        <div className="flex-1 min-w-0">
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0">
              <h3
                className={`font-display font-semibold line-clamp-2 ${
                  compact ? 'text-base' : 'text-lg'
                }`}
              >
                {download.title}
              </h3>
              <div className="flex flex-wrap items-center gap-3 mt-1.5 text-sm text-muted-foreground">
                {download.size && <span>{formatBytes(download.size)}</span>}
                {download.seeders !== undefined && (
                  <span>{download.seeders} seeders</span>
                )}
                <span
                  className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-lg text-xs font-medium ${config.bgColor} ${config.textColor}`}
                >
                  <StatusIcon className="w-3 h-3" />
                  {config.label}
                </span>
              </div>
            </div>

            {/* Actions */}
            <div className="flex items-center gap-2 shrink-0">
              {download.status === 'failed' && onRetry && (
                <button
                  onClick={onRetry}
                  className="flex items-center gap-1.5 px-3 py-2 text-sm font-medium bg-primary text-primary-foreground rounded-xl hover:opacity-90 transition-opacity focus-ring"
                >
                  <RefreshCwIcon className="w-4 h-4" />
                  <span className="hidden sm:inline">Retry</span>
                </button>
              )}
              {['queued', 'downloading', 'paused'].includes(download.status) &&
                onCancel && (
                  <button
                    onClick={onCancel}
                    disabled={isCancelling}
                    className="flex items-center gap-1.5 px-3 py-2 text-sm font-medium bg-destructive/10 text-destructive rounded-xl hover:bg-destructive hover:text-destructive-foreground disabled:opacity-50 transition-all focus-ring"
                  >
                    <XCircleIcon className="w-4 h-4" />
                    <span className="hidden sm:inline">
                      {isCancelling ? 'Cancelling...' : 'Cancel'}
                    </span>
                  </button>
                )}
            </div>
          </div>

          {/* Error Message */}
          {download.errorMessage && (
            <div className="flex items-start gap-2 mt-3 p-3 bg-destructive/5 rounded-xl">
              <AlertCircleIcon className="w-4 h-4 text-destructive shrink-0 mt-0.5" />
              <p className="text-sm text-destructive">{download.errorMessage}</p>
            </div>
          )}

          {/* Progress Bar */}
          {showProgress && download.status === 'downloading' && (
            <div className="mt-4 space-y-2">
              <div className="flex items-center justify-between text-sm">
                <span className="font-medium text-primary">
                  {formatProgress(download.progress)}
                </span>
                {download.size && (
                  <span className="text-muted-foreground">
                    {formatBytes(download.size * download.progress)} /{' '}
                    {formatBytes(download.size)}
                  </span>
                )}
              </div>
              <div className="relative h-2.5 bg-muted rounded-full overflow-hidden">
                {/* Animated background */}
                <div
                  className="absolute inset-0 bg-gradient-to-r from-primary/20 via-primary/40 to-primary/20"
                  style={{
                    backgroundSize: '200% 100%',
                    animation: 'shimmer 2s linear infinite',
                  }}
                />
                {/* Progress fill */}
                <div
                  className="relative h-full bg-gradient-to-r from-primary to-amber-500 rounded-full transition-all duration-500 ease-out"
                  style={{ width: `${download.progress * 100}%` }}
                >
                  {/* Shine effect */}
                  <div className="absolute inset-0 bg-gradient-to-r from-transparent via-white/20 to-transparent" />
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
