import { useState } from 'react';
import { Link } from 'react-router-dom';
import { formatBytes, type Download } from '@/lib/api';
import { formatRelativeDate } from '@/lib/format';
import { AlertCircleIcon, LoadingSpinner, ChevronDownIcon } from '@/components/icons';
import { ProtocolBadge } from '@/components/ProtocolBadge';
import { statusConfig } from './helpers.js';
import { DownloadProgress } from './DownloadProgress.js';
import { DownloadActions } from './DownloadActions.js';
import { QualityComparisonPanel } from './QualityComparisonPanel.js';
import { requireDefined } from '../../../shared/utils/assert.js';

function PendingReviewActions({
  onApprove,
  onReject,
  onRejectWithSearch,
  isApproving,
  isRejectingDismiss,
  isRejectingWithSearch,
}: {
  onApprove?: (() => void) | undefined;
  onReject?: (() => void) | undefined;
  onRejectWithSearch?: (() => void) | undefined;
  isApproving?: boolean | undefined;
  isRejectingDismiss?: boolean | undefined;
  isRejectingWithSearch?: boolean | undefined;
}) {
  const isAnyPending = isApproving || isRejectingDismiss || isRejectingWithSearch;

  return (
    <div className="flex items-center gap-2 mt-3">
      {onApprove && (
        <button
          type="button"
          onClick={onApprove}
          disabled={isAnyPending}
          className="flex items-center gap-1.5 px-3 py-2 text-sm font-medium bg-success/10 text-success rounded-xl hover:bg-success hover:text-white disabled:opacity-50 transition-all focus-ring"
        >
          {isApproving ? 'Approving...' : 'Approve'}
        </button>
      )}
      {onReject && (
        <button
          type="button"
          onClick={onReject}
          disabled={isAnyPending}
          className="flex items-center gap-1.5 px-3 py-2 text-sm font-medium bg-destructive/10 text-destructive rounded-xl hover:bg-destructive hover:text-destructive-foreground disabled:opacity-50 transition-all focus-ring"
        >
          {isRejectingDismiss ? 'Rejecting...' : 'Reject'}
        </button>
      )}
      {onRejectWithSearch && (
        <button
          type="button"
          onClick={onRejectWithSearch}
          disabled={isAnyPending}
          className="flex items-center gap-1.5 px-3 py-2 text-sm font-medium text-destructive/70 border border-destructive/20 rounded-xl hover:bg-destructive/10 disabled:opacity-50 transition-all focus-ring"
        >
          {isRejectingWithSearch ? 'Rejecting...' : 'Reject & Search'}
        </button>
      )}
    </div>
  );
}

function PendingReviewDetails({
  download,
  onApprove,
  onReject,
  onRejectWithSearch,
  isApproving,
  isRejectingDismiss,
  isRejectingWithSearch,
}: {
  download: Download;
  onApprove?: (() => void) | undefined;
  onReject?: (() => void) | undefined;
  onRejectWithSearch?: (() => void) | undefined;
  isApproving?: boolean | undefined;
  isRejectingDismiss?: boolean | undefined;
  isRejectingWithSearch?: boolean | undefined;
}) {
  const [expanded, setExpanded] = useState(!download.qualityGate ? true : false);
  const hasGate = !!download.qualityGate;

  if (hasGate) {
    const holdCount = download.qualityGate!.holdReasons.length;
    const summary = holdCount > 0
      ? `${holdCount} hold reason${holdCount !== 1 ? 's' : ''}`
      : 'Pending review';

    return (
      <div className="mt-3">
        <button
          type="button"
          onClick={() => setExpanded(!expanded)}
          className="flex items-center gap-2 px-3 py-1.5 text-sm font-medium text-amber-600 dark:text-amber-400 bg-amber-500/10 rounded-lg hover:bg-amber-500/20 transition-all focus-ring"
          aria-expanded={expanded}
          aria-label={expanded ? 'Collapse quality comparison' : 'Expand quality comparison'}
        >
          <ChevronDownIcon className={`w-3.5 h-3.5 transition-transform duration-200 ${expanded ? 'rotate-180' : ''}`} />
          {summary}
        </button>
        {expanded && (
          <div className="mt-3 animate-fade-in">
            <QualityComparisonPanel data={download.qualityGate!} />
            <PendingReviewActions
              onApprove={onApprove}
              onReject={onReject}
              onRejectWithSearch={onRejectWithSearch}
              isApproving={isApproving}
              isRejectingDismiss={isRejectingDismiss}
              isRejectingWithSearch={isRejectingWithSearch}
            />
          </div>
        )}
      </div>
    );
  }

  // No qualityGate data — show action buttons directly without comparison panel
  return (
    <div className="mt-3">
      <PendingReviewActions
        onApprove={onApprove}
        onReject={onReject}
        onRejectWithSearch={onRejectWithSearch}
        isApproving={isApproving}
        isRejectingDismiss={isRejectingDismiss}
        isRejectingWithSearch={isRejectingWithSearch}
      />
    </div>
  );
}

function DownloadStatusDetails({
  download,
  onApprove,
  onReject,
  onRejectWithSearch,
  isApproving,
  isRejectingDismiss,
  isRejectingWithSearch,
}: {
  download: Download;
  onApprove?: (() => void) | undefined;
  onReject?: (() => void) | undefined;
  onRejectWithSearch?: (() => void) | undefined;
  isApproving?: boolean | undefined;
  isRejectingDismiss?: boolean | undefined;
  isRejectingWithSearch?: boolean | undefined;
}) {
  return (
    <>
      {download.errorMessage && (
        <div className="flex items-start gap-2 mt-3 p-3 bg-destructive/5 rounded-xl">
          <AlertCircleIcon className="w-4 h-4 text-destructive shrink-0 mt-0.5" />
          <p className="text-sm text-destructive">{download.errorMessage}</p>
        </div>
      )}
      {download.status === 'checking' && (
        <div className="flex items-center gap-2 mt-3 text-sm text-muted-foreground">
          <LoadingSpinner className="w-4 h-4" />
          Checking audio quality...
        </div>
      )}
      {download.status === 'pending_review' && (
        <PendingReviewDetails
          download={download}
          onApprove={onApprove}
          onReject={onReject}
          onRejectWithSearch={onRejectWithSearch}
          isApproving={isApproving}
          isRejectingDismiss={isRejectingDismiss}
          isRejectingWithSearch={isRejectingWithSearch}
        />
      )}
    </>
  );
}

function DownloadTitle({ download, compact }: { download: Download; compact: boolean }) {
  return (
    <h3 className={`font-display font-semibold line-clamp-2 ${compact ? 'text-base' : 'text-lg'}`}>
      {download.bookId != null ? (
        <Link to={`/books/${download.bookId}`} className="hover:text-primary transition-colors">
          {download.title}
        </Link>
      ) : (
        download.title
      )}
    </h3>
  );
}

function DownloadMetadata({ download, compact, config, StatusIcon }: {
  download: Download;
  compact: boolean;
  config: { bgColor: string; textColor: string; label: string };
  StatusIcon: React.ElementType;
}) {
  return (
    <div className="flex flex-wrap items-center gap-3 mt-1.5 text-sm text-muted-foreground">
      {download.size && <span>{formatBytes(download.size)}</span>}
      {download.seeders != null && download.seeders > 0 && download.protocol !== 'usenet' && (
        <span>{download.seeders} seeders</span>
      )}
      <ProtocolBadge protocol={download.protocol} />
      {download.indexerName && (
        <span
          data-testid="indexer-badge"
          className="text-xs px-1.5 py-0.5 rounded-md font-medium bg-muted/50 text-muted-foreground"
        >
          {download.indexerName}
        </span>
      )}
      <span className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-lg text-xs font-medium ${config.bgColor} ${config.textColor}`}>
        <StatusIcon className="w-3 h-3" />
        {config.label}
      </span>
      {compact && download.completedAt != null && (
        <span
          className="text-xs text-muted-foreground/50 tabular-nums"
          title={new Date(download.completedAt).toLocaleString()}
        >
          · {formatRelativeDate(download.completedAt)}
        </span>
      )}
    </div>
  );
}

export function DownloadActivityCard({
  download,
  onCancel,
  onRetry,
  onApprove,
  onReject,
  onRejectWithSearch,
  onDelete,
  isCancelling,
  isApproving,
  isRejectingDismiss,
  isRejectingWithSearch,
  isDeleting,
  isRetrying,
  showProgress = true,
  index = 0,
  compact = false,
}: {
  download: Download;
  onCancel?: (() => void) | undefined;
  onRetry?: (() => void) | undefined;
  onApprove?: (() => void) | undefined;
  onReject?: (() => void) | undefined;
  onRejectWithSearch?: (() => void) | undefined;
  onDelete?: (() => void) | undefined;
  isCancelling?: boolean | undefined;
  isApproving?: boolean | undefined;
  isRejectingDismiss?: boolean | undefined;
  isRejectingWithSearch?: boolean | undefined;
  isDeleting?: boolean | undefined;
  isRetrying?: boolean | undefined;
  showProgress?: boolean;
  index?: number;
  compact?: boolean;
}) {
  const config = requireDefined(
    statusConfig[download.status] || statusConfig.queued,
    `DownloadActivityCard: statusConfig missing both "${download.status}" and fallback "queued"`,
  );
  const StatusIcon = config.icon;
  const isPendingReview = download.status === 'pending_review';

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
              <DownloadTitle download={download} compact={compact} />
              <DownloadMetadata download={download} compact={compact} config={config} StatusIcon={StatusIcon} />
            </div>

            {/* Hide top-level actions for pending_review — they move into the expand panel */}
            {!isPendingReview && (
              <DownloadActions
                download={download}
                onCancel={onCancel}
                onRetry={onRetry}
                onDelete={onDelete}
                isCancelling={isCancelling}
                isDeleting={isDeleting}
                isRetrying={isRetrying}
              />
            )}
          </div>

          <DownloadStatusDetails
            download={download}
            onApprove={onApprove}
            onReject={onReject}
            onRejectWithSearch={onRejectWithSearch}
            isApproving={isApproving}
            isRejectingDismiss={isRejectingDismiss}
            isRejectingWithSearch={isRejectingWithSearch}
          />

          {showProgress && download.status === 'downloading' && (
            <DownloadProgress download={download} />
          )}
        </div>
      </div>
    </div>
  );
}
