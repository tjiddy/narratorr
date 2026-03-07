import {
  XCircleIcon,
  RefreshIcon as RefreshCwIcon,
} from '@/components/icons';
import type { Download } from '@/lib/api';

export function DownloadActions({
  download,
  onCancel,
  onRetry,
  isCancelling,
}: {
  download: Download;
  onCancel?: () => void;
  onRetry?: () => void;
  isCancelling?: boolean;
}) {
  return (
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
  );
}
