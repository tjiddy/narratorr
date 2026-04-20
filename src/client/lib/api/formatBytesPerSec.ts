/**
 * Format a download/upload rate (bytes/sec) for display.
 *
 * - `0` renders as `"0 KB/s"` (the stalled signal — users need to see this distinctly).
 * - Negative input is coerced to 0 defensively; rates should never be negative.
 * - Sub-KB rates use KB/s as the minimum display unit for consistency.
 * - Binary units throughout (1 KiB = 1024 bytes) to match existing byte formatters.
 */
export function formatBytesPerSec(bytesPerSec: number): string {
  if (!Number.isFinite(bytesPerSec) || bytesPerSec <= 0) return '0 KB/s';
  const KB = 1024;
  const MB = KB * 1024;
  const GB = MB * 1024;
  if (bytesPerSec >= GB) return `${(bytesPerSec / GB).toFixed(1)} GB/s`;
  if (bytesPerSec >= MB) return `${(bytesPerSec / MB).toFixed(1)} MB/s`;
  return `${(bytesPerSec / KB).toFixed(1)} KB/s`;
}
