import { useState } from 'react';
import { formatBytes, type Download } from '@/lib/api';
import { AlertCircleIcon, LoadingSpinner, ChevronDownIcon } from '@/components/icons';
import { ProtocolBadge } from '@/components/ProtocolBadge';
import { statusConfig } from './helpers.js';
import { DownloadProgress } from './DownloadProgress.js';
import { DownloadActions } from './DownloadActions.js';
import { QualityComparisonPanel } from './QualityComparisonPanel.js';

function PendingReviewDetails({
  download,
  onApprove,
  onReject,
  isApproving,
  isRejecting,
}: {
  download: Download;
  onApprove?: () => void;
  onReject?: () => void;
  isApproving?: boolean;
  isRejecting?: boolean;
}) {
  const [expanded, setExpanded] = useState(false);

  if (!download.qualityGate) return null;

  const holdCount = download.qualityGate.holdReasons.length;
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
          <QualityComparisonPanel data={download.qualityGate} />
          <div className="flex items-center gap-2 mt-3">
            {onApprove && (
              <button
                type="button"
                onClick={onApprove}
                disabled={isApproving}
                className="flex items-center gap-1.5 px-3 py-2 text-sm font-medium bg-success/10 text-success rounded-xl hover:bg-success hover:text-white disabled:opacity-50 transition-all focus-ring"
              >
                {isApproving ? 'Approving...' : 'Approve'}
              </button>
            )}
            {onReject && (
              <button
                type="button"
                onClick={onReject}
                disabled={isRejecting}
                className="flex items-center gap-1.5 px-3 py-2 text-sm font-medium bg-destructive/10 text-destructive rounded-xl hover:bg-destructive hover:text-destructive-foreground disabled:opacity-50 transition-all focus-ring"
              >
                {isRejecting ? 'Rejecting...' : 'Reject'}
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function DownloadStatusDetails({
  download,
  onApprove,
  onReject,
  isApproving,
  isRejecting,
}: {
  download: Download;
  onApprove?: () => void;
  onReject?: () => void;
  isApproving?: boolean;
  isRejecting?: boolean;
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
      {download.status === 'pending_review' && download.qualityGate && (
        <PendingReviewDetails
          download={download}
          onApprove={onApprove}
          onReject={onReject}
          isApproving={isApproving}
          isRejecting={isRejecting}
        />
      )}
    </>
  );
}

export function DownloadCard({
  download,
  onCancel,
  onRetry,
  onApprove,
  onReject,
  isCancelling,
  isApproving,
  isRejecting,
  showProgress = true,
  index = 0,
  compact = false,
}: {
  download: Download;
  onCancel?: () => void;
  onRetry?: () => void;
  onApprove?: () => void;
  onReject?: () => void;
  isCancelling?: boolean;
  isApproving?: boolean;
  isRejecting?: boolean;
  showProgress?: boolean;
  index?: number;
  compact?: boolean;
}) {
  const config = statusConfig[download.status] || statusConfig.queued;
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
              <h3 className={`font-display font-semibold line-clamp-2 ${compact ? 'text-base' : 'text-lg'}`}>
                {download.title}
              </h3>
              <div className="flex flex-wrap items-center gap-3 mt-1.5 text-sm text-muted-foreground">
                {download.size && <span>{formatBytes(download.size)}</span>}
                {download.seeders !== undefined && download.protocol !== 'usenet' && (
                  <span>{download.seeders} seeders</span>
                )}
                <ProtocolBadge protocol={download.protocol} />
                <span className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-lg text-xs font-medium ${config.bgColor} ${config.textColor}`}>
                  <StatusIcon className="w-3 h-3" />
                  {config.label}
                </span>
              </div>
            </div>

            {/* Hide top-level actions for pending_review — they move into the expand panel */}
            {!isPendingReview && (
              <DownloadActions
                download={download}
                onCancel={onCancel}
                onRetry={onRetry}
                onApprove={onApprove}
                onReject={onReject}
                isCancelling={isCancelling}
                isApproving={isApproving}
                isRejecting={isRejecting}
              />
            )}
          </div>

          <DownloadStatusDetails
            download={download}
            onApprove={onApprove}
            onReject={onReject}
            isApproving={isApproving}
            isRejecting={isRejecting}
          />

          {showProgress && download.status === 'downloading' && (
            <DownloadProgress download={download} />
          )}
        </div>
      </div>
    </div>
  );
}
