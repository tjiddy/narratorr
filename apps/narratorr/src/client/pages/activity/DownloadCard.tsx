import { formatBytes, type Download } from '@/lib/api';
import { AlertCircleIcon } from '@/components/icons';
import { ProtocolBadge } from '@/components/ProtocolBadge';
import { statusConfig } from './helpers.js';
import { DownloadProgress } from './DownloadProgress.js';
import { DownloadActions } from './DownloadActions.js';

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
        <div className={`shrink-0 p-2.5 rounded-xl ${config.bgColor}`}>
          <StatusIcon className={`w-5 h-5 ${config.color}`} />
        </div>

        <div className="flex-1 min-w-0">
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0">
              <h3 className={`font-display font-semibold line-clamp-2 ${compact ? 'text-base' : 'text-lg'}`}>
                {download.title}
              </h3>
              <div className="flex flex-wrap items-center gap-3 mt-1.5 text-sm text-muted-foreground">
                {download.size && <span>{formatBytes(download.size)}</span>}
                {download.seeders !== undefined && (
                  <span>{download.seeders} seeders</span>
                )}
                <ProtocolBadge protocol={download.protocol} />
                <span className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-lg text-xs font-medium ${config.bgColor} ${config.textColor}`}>
                  <StatusIcon className="w-3 h-3" />
                  {config.label}
                </span>
              </div>
            </div>

            <DownloadActions
              download={download}
              onCancel={onCancel}
              onRetry={onRetry}
              isCancelling={isCancelling}
            />
          </div>

          {download.errorMessage && (
            <div className="flex items-start gap-2 mt-3 p-3 bg-destructive/5 rounded-xl">
              <AlertCircleIcon className="w-4 h-4 text-destructive shrink-0 mt-0.5" />
              <p className="text-sm text-destructive">{download.errorMessage}</p>
            </div>
          )}

          {showProgress && download.status === 'downloading' && (
            <DownloadProgress download={download} />
          )}
        </div>
      </div>
    </div>
  );
}
