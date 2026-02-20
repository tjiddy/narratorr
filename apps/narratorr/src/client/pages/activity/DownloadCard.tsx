import { formatBytes, formatProgress, type Download } from '@/lib/api';
import {
  ClockIcon,
  ArrowDownIcon,
  CheckCircleIcon,
  PackageIcon,
  AlertCircleIcon,
  PauseIcon,
  XCircleIcon,
  RefreshIcon as RefreshCwIcon,
} from '@/components/icons';
import { ProtocolBadge } from '@/components/ProtocolBadge';

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

export function DownloadCard({
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
                <ProtocolBadge protocol={download.protocol} />
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
