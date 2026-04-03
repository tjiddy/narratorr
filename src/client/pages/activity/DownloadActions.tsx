import {
  XCircleIcon,
  RefreshIcon as RefreshCwIcon,
  CheckCircleIcon,
  TrashIcon,
} from '@/components/icons';
import { Button } from '@/components/Button';
import type { Download } from '@/lib/api';
import { isTerminalStatus } from '../../../shared/download-status-registry.js';

function PendingActionButtons({ onApprove, onReject, isApproving, isRejecting }: {
  onApprove?: () => void;
  onReject?: () => void;
  isApproving?: boolean;
  isRejecting?: boolean;
}) {
  return (
    <>
      {onApprove && (
        <Button
          variant="success"
          size="sm"
          icon={CheckCircleIcon}
          loading={isApproving}
          onClick={onApprove}
        >
          <span className="hidden sm:inline">
            {isApproving ? 'Approving...' : 'Approve'}
          </span>
        </Button>
      )}
      {onReject && (
        <Button
          variant="destructive"
          size="sm"
          icon={XCircleIcon}
          loading={isRejecting}
          onClick={onReject}
        >
          <span className="hidden sm:inline">
            {isRejecting ? 'Rejecting...' : 'Reject'}
          </span>
        </Button>
      )}
    </>
  );
}

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
  isRetrying,
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
  isRetrying?: boolean;
}) {
  const isRetryable = download.status === 'failed' && download.bookId != null;

  return (
    <div className="flex items-center gap-2 shrink-0">
      {download.status === 'pending_review' && (
        <PendingActionButtons
          onApprove={onApprove}
          onReject={onReject}
          isApproving={isApproving}
          isRejecting={isRejecting}
        />
      )}
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
