import {
  XCircleIcon,
  RefreshIcon as RefreshCwIcon,
  TrashIcon,
} from '@/components/icons';
import { Button } from '@/components/Button';
import type { Download } from '@/lib/api';
import { isTerminalStatus } from '../../../shared/download-status-registry.js';

export function DownloadActions({
  download,
  onCancel,
  onRetry,
  onDelete,
  isCancelling,
  isDeleting,
  isRetrying,
}: {
  download: Download;
  onCancel?: () => void;
  onRetry?: () => void;
  onDelete?: () => void;
  isCancelling?: boolean;
  isDeleting?: boolean;
  isRetrying?: boolean;
}) {
  const isRetryable = download.status === 'failed' && download.bookId != null;

  return (
    <div className="flex items-center gap-2 shrink-0">
      {isRetryable && onRetry && (
        <Button
          variant="primary"
          size="sm"
          icon={RefreshCwIcon}
          loading={isRetrying}
          onClick={onRetry}
          type="button"
        >
          <span className="hidden sm:inline">
            {isRetrying ? 'Retrying...' : 'Retry'}
          </span>
        </Button>
      )}
      {['queued', 'downloading', 'paused'].includes(download.status) && onCancel && (
        <Button
          variant="destructive"
          size="sm"
          icon={XCircleIcon}
          loading={isCancelling}
          onClick={onCancel}
        >
          <span className="hidden sm:inline">
            {isCancelling ? 'Cancelling...' : 'Cancel & Blacklist'}
          </span>
        </Button>
      )}
      {isTerminalStatus(download.status) && onDelete && (
        <Button
          variant="destructive"
          size="sm"
          icon={TrashIcon}
          loading={isDeleting}
          onClick={onDelete}
          aria-label="Delete"
          type="button"
        >
          <span className="hidden sm:inline">
            {isDeleting ? 'Deleting...' : 'Delete'}
          </span>
        </Button>
      )}
    </div>
  );
}
