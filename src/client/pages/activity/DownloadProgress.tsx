import { formatBytes, formatBytesPerSec, formatProgress, type Download } from '@/lib/api';

export function DownloadProgress({ download }: { download: Download }) {
  // Speed is rendered when the server reported a numeric rate (including 0,
  // the stalled signal). null / undefined means "not reported" — omit the label.
  const showSpeed = typeof download.downloadSpeed === 'number';
  const isStalled = download.downloadSpeed === 0;
  return (
    <div className="mt-4 space-y-2">
      <div className="flex items-center justify-between text-sm">
        <span className="font-medium text-primary tabular-nums">
          {formatProgress(download.progress)}
        </span>
        <span className="text-muted-foreground tabular-nums">
          {showSpeed && (
            <span className={isStalled ? 'text-amber-500' : undefined}>
              {formatBytesPerSec(download.downloadSpeed as number)}
            </span>
          )}
          {showSpeed && download.size ? <span aria-hidden="true"> · </span> : null}
          {download.size && (
            <>
              {formatBytes(download.size * download.progress)} /{' '}
              {formatBytes(download.size)}
            </>
          )}
        </span>
      </div>
      <div className="relative h-2.5 bg-muted rounded-full overflow-hidden">
        {/* Animated background */}
        <div
          className="absolute inset-0 bg-gradient-to-r from-primary/20 via-primary/40 to-primary/20"
          style={{
            backgroundSize: '200% 100%',
            animation: 'shimmer 2s linear infinite',
          }}
        />
        {/* Progress fill */}
        <div
          className="relative h-full bg-gradient-to-r from-primary to-amber-500 rounded-full transition-all duration-500 ease-out"
          style={{ width: `${download.progress * 100}%` }}
        >
          {/* Shine effect */}
          <div className="absolute inset-0 bg-gradient-to-r from-transparent via-white/20 to-transparent" />
        </div>
      </div>
    </div>
  );
}
