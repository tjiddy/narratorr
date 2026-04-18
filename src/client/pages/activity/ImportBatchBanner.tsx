import { useMemo } from 'react';
import { Link } from 'react-router-dom';
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

  return (
    <div className="glass-card rounded-2xl p-4 sm:p-5 animate-fade-in-up">
      <div className="flex items-center justify-between mb-2">
        <p className="text-sm font-medium">
          Imports &middot; {processed} of {total} processed &middot; {completed} imported
          {failed > 0 && (
            <>
              {' '}&middot;{' '}
              <Link
                to="/activity?tab=history&filter=import_failed"
                className="text-destructive hover:underline"
              >
                {failed} failed &rarr;
              </Link>
            </>
          )}
        </p>
      </div>
      <div className="h-1.5 rounded-full bg-muted overflow-hidden">
        <div
          className="h-full rounded-full bg-primary transition-all duration-500 relative overflow-hidden"
          style={{ width: `${Math.round(progress * 100)}%` }}
        >
          {processed < total && (
            <div className="absolute inset-0 bg-gradient-to-r from-transparent via-white/20 to-transparent animate-shimmer" />
          )}
        </div>
      </div>
    </div>
  );
}
