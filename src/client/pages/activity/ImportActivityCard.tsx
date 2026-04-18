import { CheckIcon, LoadingSpinner, HeadphonesIcon, XIcon } from '@/components/icons';
import { resolveCoverUrl } from '@/lib/url-utils.js';
import { formatBytes } from '@/lib/api';
import type { ImportJobWithBook } from '@/lib/api/import-jobs';
import type { PhaseHistoryEntry } from '../../../server/services/import-queue-worker.js';

const PHASE_LABELS: Record<string, string> = {
  analyzing: 'Analyzing',
  renaming: 'Renaming files',
  copying: 'Copying files',
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
  if (phase === 'renaming' && byteCounter) {
    return `${label} \u00B7 ${pct}% (${byteCounter.current}/${byteCounter.total} files)`;
  }
  if (byteCounter && byteCounter.total > 0) {
    return `${label} \u00B7 ${pct}% (${formatBytes(byteCounter.current)}/${formatBytes(byteCounter.total)})`;
  }
  return `${label} \u00B7 ${pct}%`;
}

function PhaseIcon({ isDone, isCurrent }: { isDone: boolean; isCurrent: boolean }) {
  if (isDone) {
    return (
      <div className="w-4 h-4 rounded-full bg-success/20 flex items-center justify-center ring-2 ring-success/10">
        <CheckIcon className="w-2.5 h-2.5 text-success" />
      </div>
    );
  }
  if (isCurrent) {
    return (
      <div className="w-4 h-4 flex items-center justify-center">
        <LoadingSpinner className="w-4 h-4 text-amber-500" />
      </div>
    );
  }
  return <div className="w-2.5 h-2.5 rounded-full bg-muted-foreground/20" />;
}

function PhaseRow({ entry, isLast, progress, byteCounter }: {
  entry: PhaseHistoryEntry;
  isLast: boolean;
  progress?: number;
  byteCounter?: { current: number; total: number };
}) {
  const isDone = entry.completedAt !== undefined;
  const isCurrent = !isDone && isLast;
  const showProgress = isCurrent && (entry.phase === 'copying' || entry.phase === 'renaming');
  const label = PHASE_LABELS[entry.phase] ?? entry.phase;
  const statusText = isDone ? 'completed' : isCurrent ? 'in progress' : 'pending';

  return (
    <div className="relative flex items-center gap-2.5 text-xs py-0.5" aria-label={`${label}: ${statusText}`}>
      <div className="absolute -left-[22px] flex items-center justify-center">
        <PhaseIcon isDone={isDone} isCurrent={isCurrent} />
      </div>
      <div className="flex-1 min-w-0">
        {showProgress ? (
          <div className="relative overflow-hidden rounded-md py-0.5 px-1.5 -mx-1.5">
            {progress !== undefined && (
              <div
                className="absolute inset-0 bg-amber-500/8 dark:bg-amber-500/12 rounded-md transition-all duration-700 ease-out"
                style={{ width: `${Math.round(progress * 100)}%` }}
                role="progressbar"
                aria-valuenow={Math.round(progress * 100)}
                aria-valuemin={0}
                aria-valuemax={100}
              />
            )}
            <span className="relative text-foreground font-medium">
              {formatProgress(entry.phase, progress, byteCounter)}
            </span>
          </div>
        ) : (
          <span className={isDone ? 'text-muted-foreground' : 'text-foreground'}>
            {label}
            {isDone && entry.completedAt && (
              <span className="ml-1.5 text-muted-foreground/50 tabular-nums">
                {formatElapsed(entry.startedAt, entry.completedAt)}
              </span>
            )}
          </span>
        )}
      </div>
    </div>
  );
}

export interface ImportActivityCardProps {
  job: ImportJobWithBook & { _progress?: number; _byteCounter?: { current: number; total: number }; _progressPhase?: string };
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
        isProcessing ? 'ring-1 ring-amber-500/20 shadow-lg shadow-amber-500/5 dark:ring-amber-500/30 dark:shadow-amber-500/10' : ''
      } ${isCompleted ? 'animate-fade-out' : ''}`}
    >
      {/* Header with cover + title */}
      <div className="flex items-start gap-3 mb-3">
        {coverUrl ? (
          <img src={coverUrl} alt={`Cover for ${job.book.title}`} className="w-10 h-10 rounded-lg object-cover flex-shrink-0 shadow-sm" />
        ) : (
          <div className="w-10 h-10 rounded-lg bg-muted flex items-center justify-center flex-shrink-0">
            <HeadphonesIcon className="w-5 h-5 text-muted-foreground/60" />
          </div>
        )}
        <div className="min-w-0 flex-1">
          <h3 className="font-medium text-sm truncate">{job.book.title}</h3>
          {job.book.primaryAuthorName && (
            <p className="text-xs text-muted-foreground truncate">{job.book.primaryAuthorName}</p>
          )}
        </div>
        {isCompleted && (
          <span className="text-[11px] text-success font-medium flex items-center gap-1 bg-success/10 px-2 py-0.5 rounded-full">
            <CheckIcon className="w-3 h-3" />Imported
          </span>
        )}
        {isFailed && (
          <span className="text-[11px] text-destructive font-medium flex items-center gap-1 bg-destructive/10 px-2 py-0.5 rounded-full">
            <XIcon className="w-3 h-3" />Failed
          </span>
        )}
      </div>

      {/* Phase checklist */}
      {phaseHistory.length > 0 && (
        <div className="relative pl-[22px] space-y-0.5 mt-1">
          {/* Vertical connector — segmented by completion state */}
          <div className="absolute left-[7px] top-1.5 bottom-1.5 w-px bg-border/60 dark:bg-border/40" />
          {phaseHistory.map((entry, idx) => {
            const isDone = entry.completedAt !== undefined;
            const phaseMatches = job._progressPhase === entry.phase;
            const progress = phaseMatches ? job._progress : undefined;
            const byteCounter = phaseMatches ? job._byteCounter : undefined;
            if (isDone && idx < phaseHistory.length - 1) {
              return (
                <div key={entry.phase}>
                  <div
                    className="absolute left-[7px] w-px bg-success/40"
                    style={{
                      top: `${(idx / phaseHistory.length) * 100}%`,
                      height: `${(1 / phaseHistory.length) * 100}%`,
                    }}
                  />
                  <PhaseRow entry={entry} isLast={false} progress={progress} byteCounter={byteCounter} />
                </div>
              );
            }
            return (
              <PhaseRow
                key={entry.phase}
                entry={entry}
                isLast={idx === phaseHistory.length - 1}
                progress={progress}
                byteCounter={byteCounter}
              />
            );
          })}
        </div>
      )}
    </div>
  );
}
