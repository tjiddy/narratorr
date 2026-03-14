import { useState } from 'react';
import { ChevronDownIcon } from '@/components/icons';
import { useBookFiles } from '@/hooks/useLibrary';
import { formatBytes } from '@/lib/api';

export function FileList({ bookId }: { bookId: number }) {
  const [expanded, setExpanded] = useState(false);
  const { data: files, isLoading, isError } = useBookFiles(bookId);

  if (isLoading) {
    return <p className="text-sm text-muted-foreground">Loading files…</p>;
  }

  if (isError) {
    return <p className="text-sm text-destructive">Failed to load files</p>;
  }

  if (!files) return null;

  return (
    <div>
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        className="flex w-full items-center gap-2 text-sm font-semibold uppercase tracking-wider text-muted-foreground mb-3 hover:text-foreground transition-colors"
      >
        <ChevronDownIcon
          className={`w-3 h-3 transition-transform duration-200 ${expanded ? '' : '-rotate-90'}`}
        />
        Files ({files.length})
      </button>

      {expanded && (
        <div className="glass-card rounded-2xl p-4">
          {files.length === 0 ? (
            <p className="text-sm text-muted-foreground">No audio files found</p>
          ) : (
            <ul className="divide-y divide-border/50">
              {files.map((file) => (
                <li key={file.name} className="flex items-center justify-between gap-3 py-2 first:pt-0 last:pb-0">
                  <span className="truncate text-sm" title={file.name}>
                    {file.name}
                  </span>
                  <span className="whitespace-nowrap text-xs text-muted-foreground tabular-nums">
                    {formatBytes(file.size)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
