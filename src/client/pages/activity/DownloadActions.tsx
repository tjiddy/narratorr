import {
  XCircleIcon,
  RefreshIcon as RefreshCwIcon,
  CheckCircleIcon,
  TrashIcon,
} from '@/components/icons';
import type { Download } from '@/lib/api';
import { isTerminalStatus } from '../../../shared/download-status-registry.js';

export function DownloadActions({
  download,
  onCancel,
  onRetry,
  onApprove,
  onReject,
  onDelete,
  isCancelling,
  isApproving,
  isRejecting,
  isDeleting,
}: {
  download: Download;
  onCancel?: () => void;
  onRetry?: () => void;
  onApprove?: () => void;
  onReject?: () => void;
  onDelete?: () => void;
  isCancelling?: boolean;
  isApproving?: boolean;
  isRejecting?: boolean;
  isDeleting?: boolean;
}) {
  return (
    <div className="flex items-center gap-2 shrink-0">
      {download.status === 'pending_review' && onApprove && (
        <button
          onClick={onApprove}
          disabled={isApproving}
          className="flex items-center gap-1.5 px-3 py-2 text-sm font-medium bg-success/10 text-success rounded-xl hover:bg-success hover:text-white disabled:opacity-50 transition-all focus-ring"
        >
          <CheckCircleIcon className="w-4 h-4" />
          <span className="hidden sm:inline">
            {isApproving ? 'Approving...' : 'Approve'}
          </span>
        </button>
      )}
      {download.status === 'pending_review' && onReject && (
        <button
          onClick={onReject}
          disabled={isRejecting}
          className="flex items-center gap-1.5 px-3 py-2 text-sm font-medium bg-destructive/10 text-destructive rounded-xl hover:bg-destructive hover:text-destructive-foreground disabled:opacity-50 transition-all focus-ring"
        >
          <XCircleIcon className="w-4 h-4" />
          <span className="hidden sm:inline">
            {isRejecting ? 'Rejecting...' : 'Reject'}
          </span>
        </button>
      )}
      {download.status === 'failed' && download.bookId != null && onRetry && (
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
      {isTerminalStatus(download.status) && onDelete && (
        <button
          type="button"
          onClick={onDelete}
          disabled={isDeleting}
          aria-label="Delete"
          className="flex items-center gap-1.5 px-3 py-2 text-sm font-medium bg-destructive/10 text-destructive rounded-xl hover:bg-destructive hover:text-destructive-foreground disabled:opacity-50 transition-all focus-ring"
        >
          <TrashIcon className="w-4 h-4" />
          <span className="hidden sm:inline">
            {isDeleting ? 'Deleting...' : 'Delete'}
          </span>
        </button>
      )}
    </div>
  );
}
