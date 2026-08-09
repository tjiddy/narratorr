/** Binary bytes/sec with a KB/s floor; non-positive values render as stalled. */
export function formatBytesPerSec(bytesPerSec: number): string {
  if (!Number.isFinite(bytesPerSec) || bytesPerSec <= 0) return '0 KB/s';
  const KB = 1024;
  const MB = KB * 1024;
  const GB = MB * 1024;
  if (bytesPerSec >= GB) return `${(bytesPerSec / GB).toFixed(1)} GB/s`;
  if (bytesPerSec >= MB) return `${(bytesPerSec / MB).toFixed(1)} MB/s`;
  return `${(bytesPerSec / KB).toFixed(1)} KB/s`;
}
