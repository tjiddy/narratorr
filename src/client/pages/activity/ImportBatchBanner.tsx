import { useMemo } from 'react';
import { Link } from 'react-router-dom';
import { DownloadCloudIcon } from '@/components/icons';
import type { ImportJobWithBook } from '@/lib/api/import-jobs';

const COOLDOWN_MS = 60_000;

export interface ImportBatchBannerProps {
  jobs: ImportJobWithBook[];
  /** Current timestamp — passed from parent to keep render pure */
  now: number;
}

function filterBatchJobs(jobs: ImportJobWithBook[], now: number): ImportJobWithBook[] {
  return jobs.filter((job) => {
    if (job.status === 'pending' || job.status === 'processing') return true;
    if (job.completedAt) {
      const completedMs = new Date(job.completedAt).getTime();
      return now - completedMs < COOLDOWN_MS;
    }
    return false;
  });
}

export function ImportBatchBanner({ jobs, now }: ImportBatchBannerProps) {
  const batchJobs = useMemo(() => filterBatchJobs(jobs, now), [jobs, now]);

  if (batchJobs.length === 0) return null;

  const total = batchJobs.length;
  const completed = batchJobs.filter((j) => j.status === 'completed').length;
  const failed = batchJobs.filter((j) => j.status === 'failed').length;
  const processed = completed + failed;
  const progress = total > 0 ? processed / total : 0;
  const isActive = processed < total;

  return (
    <div className="glass-card rounded-2xl p-4 sm:p-5 animate-fade-in-up">
      <div className="flex items-center gap-3 mb-3">
        <div className="p-1.5 bg-primary/10 rounded-lg">
          <DownloadCloudIcon className="w-4 h-4 text-primary" />
        </div>
        <p className="text-sm font-medium flex-1">
          Imports &middot; {processed} of {total} processed &middot; {completed} imported
          {failed > 0 && (
            <>
              {' '}&middot;{' '}
              <Link
                to="/activity?tab=history&filter=import_failed"
                className="text-destructive hover:underline transition-colors"
              >
                {failed} failed &rarr;
              </Link>
            </>
          )}
        </p>
        {isActive && (
          <span className="text-[10px] uppercase tracking-wider text-primary font-medium tabular-nums">
            {Math.round(progress * 100)}%
          </span>
        )}
      </div>
      <div className="h-1.5 rounded-full bg-muted overflow-hidden">
        <div
          className={`h-full rounded-full transition-all duration-700 ease-out relative overflow-hidden ${
            isActive ? 'bg-primary status-bar-shimmer' : 'bg-success'
          }`}
          style={{ width: `${Math.round(progress * 100)}%` }}
        />
      </div>
    </div>
  );
}
