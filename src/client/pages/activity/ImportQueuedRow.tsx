import { HeadphonesIcon } from '@/components/icons';
import { resolveCoverUrl } from '@/lib/url-utils.js';
import type { ImportJobWithBook } from '@/lib/api/import-jobs';

export interface ImportQueuedRowProps {
  job: ImportJobWithBook;
}

export function ImportQueuedRow({ job }: ImportQueuedRowProps) {
  const coverUrl = job.book.coverUrl ? resolveCoverUrl(job.book.coverUrl, job.updatedAt) : null;

  return (
    <div className="flex items-center gap-3 py-2">
      {coverUrl ? (
        <img
          src={coverUrl}
          alt=""
          className="w-7 h-7 rounded object-cover flex-shrink-0"
        />
      ) : (
        <div className="w-7 h-7 rounded bg-muted flex items-center justify-center flex-shrink-0">
          <HeadphonesIcon className="w-3.5 h-3.5 text-muted-foreground" />
        </div>
      )}
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium truncate">{job.book.title}</p>
        {job.book.primaryAuthorName && (
          <p className="text-xs text-muted-foreground truncate">{job.book.primaryAuthorName}</p>
        )}
      </div>
      <span className="text-[10px] uppercase tracking-wider text-muted-foreground font-medium px-1.5 py-0.5 bg-muted rounded">
        Queued
      </span>
    </div>
  );
}
