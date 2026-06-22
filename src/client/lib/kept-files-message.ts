/**
 * Build the "kept N non-audio files" disclosure suffix for a delete toast (#1589). narratorr's
 * managed-file delete preserves foreign files (e-books, PDFs, subtitles, user images) co-located
 * with the audiobook; this surfaces which were left behind so the deletion isn't silently partial.
 *
 * Returns an empty string when nothing was preserved (caller shows the plain success copy).
 */
const MAX_NAMES = 3;

export function describeKeptFiles(preservedForeign: string[] | undefined): string {
  const count = preservedForeign?.length ?? 0;
  if (count === 0) return '';
  const names = preservedForeign!.slice(0, MAX_NAMES).join(', ');
  const overflow = count > MAX_NAMES ? `, +${count - MAX_NAMES} more` : '';
  return `kept ${count} non-audio file${count !== 1 ? 's' : ''} (${names}${overflow})`;
}
