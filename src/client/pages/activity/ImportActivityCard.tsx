import { CheckIcon, LoadingSpinner, HeadphonesIcon, XIcon } from '@/components/icons';
import { resolveCoverUrl } from '@/lib/url-utils.js';
import { formatBytes } from '@/lib/api';
import type { ImportJobWithBook } from '@/lib/api/import-jobs';
import type { PhaseHistoryEntry } from '../../../server/services/import-queue-worker.js';

const PHASE_LABELS: Record<string, string> = {
  analyzing: 'Analyzing',
  renaming: 'Renaming files',
  copying: 'Copying files',
  flattening: 'Flattening tracks',
  fetching_metadata: 'Fetching metadata',
};

function formatElapsed(startedAt: number, completedAt?: number): string {
  const ms = (completedAt ?? Date.now()) - startedAt;
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function formatProgress(phase: string, progress?: number, byteCounter?: { current: number; total: number }): string {
  const label = PHASE_LABELS[phase] ?? phase;
  if (progress === undefined) return label;
  const pct = Math.round(progress * 100);
  if (byteCounter && byteCounter.total > 0) {
    return `${label} \u00B7 ${pct}% (${formatBytes(byteCounter.current)}/${formatBytes(byteCounter.total)})`;
  }
  if (phase === 'flattening') {
    return `${label} \u00B7 ${pct}% \u2014 encoding`;
  }
  return `${label} \u00B7 ${pct}%`;
}

export interface ImportActivityCardProps {
  job: ImportJobWithBook & { _progress?: number; _byteCounter?: { current: number; total: number } };
}

export function ImportActivityCard({ job }: ImportActivityCardProps) {
  const isProcessing = job.status === 'processing';
  const isCompleted = job.status === 'completed';
  const isFailed = job.status === 'failed';
  const phaseHistory: PhaseHistoryEntry[] = job.phaseHistory ?? [];
  const coverUrl = job.book.coverUrl ? resolveCoverUrl(job.book.coverUrl, job.updatedAt) : null;

  return (
    <div
      className={`glass-card rounded-2xl p-4 sm:p-5 animate-fade-in-up transition-all duration-300 ${
        isProcessing ? 'ring-1 ring-amber-500/30 shadow-amber-500/10 shadow-lg' : ''
      } ${isCompleted ? 'animate-fade-out' : ''}`}
    >
      {/* Header with cover + title */}
      <div className="flex items-start gap-3 mb-3">
        {coverUrl ? (
          <img
            src={coverUrl}
            alt={`Cover for ${job.book.title}`}
            className="w-10 h-10 rounded-lg object-cover flex-shrink-0"
          />
        ) : (
          <div className="w-10 h-10 rounded-lg bg-muted flex items-center justify-center flex-shrink-0">
            <HeadphonesIcon className="w-5 h-5 text-muted-foreground" />
          </div>
        )}
        <div className="min-w-0 flex-1">
          <h3 className="font-medium text-sm truncate">{job.book.title}</h3>
          {job.book.primaryAuthorName && (
            <p className="text-xs text-muted-foreground truncate">{job.book.primaryAuthorName}</p>
          )}
        </div>
        {isCompleted && (
          <span className="text-xs text-success font-medium flex items-center gap-1">
            <CheckIcon className="w-3.5 h-3.5" />
            Imported
          </span>
        )}
        {isFailed && (
          <span className="text-xs text-destructive font-medium flex items-center gap-1">
            <XIcon className="w-3.5 h-3.5" />
            Failed
          </span>
        )}
      </div>

      {/* Phase checklist */}
      {phaseHistory.length > 0 && (
        <div className="relative pl-5 space-y-1.5">
          {/* Vertical connector line */}
          <div className="absolute left-[7px] top-1 bottom-1 w-0.5 bg-muted rounded-full" />

          {phaseHistory.map((entry, idx) => {
            const isDone = entry.completedAt !== undefined;
            const isCurrent = !isDone && idx === phaseHistory.length - 1;
            const isCurrentCopy = isCurrent && entry.phase === 'copying';
            const isCurrentFlatten = isCurrent && entry.phase === 'flattening';
            const showProgress = isCurrentCopy || isCurrentFlatten;

            return (
              <div
                key={entry.phase}
                className="relative flex items-center gap-2 text-xs"
                aria-label={`${PHASE_LABELS[entry.phase] ?? entry.phase}: ${isDone ? 'completed' : isCurrent ? 'in progress' : 'pending'}`}
              >
                {/* Phase icon */}
                <div className="absolute -left-5 flex items-center justify-center">
                  {isDone ? (
                    <div className="w-3.5 h-3.5 rounded-full bg-success/20 flex items-center justify-center">
                      <CheckIcon className="w-2.5 h-2.5 text-success" />
                    </div>
                  ) : isCurrent ? (
                    <div className="w-3.5 h-3.5 flex items-center justify-center">
                      <LoadingSpinner className="w-3.5 h-3.5 text-amber-500" />
                    </div>
                  ) : (
                    <div className="w-2 h-2 rounded-full bg-muted" />
                  )}
                </div>

                {/* Phase label + progress */}
                <div className="flex-1 min-w-0">
                  {showProgress ? (
                    <div className="relative overflow-hidden rounded">
                      {job._progress !== undefined && (
                        <div
                          className="absolute inset-0 bg-amber-500/10 rounded transition-all duration-500"
                          style={{ width: `${Math.round((job._progress ?? 0) * 100)}%` }}
                          role="progressbar"
                          aria-valuenow={Math.round((job._progress ?? 0) * 100)}
                          aria-valuemin={0}
                          aria-valuemax={100}
                        />
                      )}
                      <span className="relative text-foreground">
                        {formatProgress(entry.phase, job._progress, job._byteCounter)}
                      </span>
                    </div>
                  ) : (
                    <span className={isDone ? 'text-muted-foreground' : 'text-foreground'}>
                      {PHASE_LABELS[entry.phase] ?? entry.phase}
                      {isDone && entry.completedAt && (
                        <span className="ml-1 text-muted-foreground/60">
                          {formatElapsed(entry.startedAt, entry.completedAt)}
                        </span>
                      )}
                    </span>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
