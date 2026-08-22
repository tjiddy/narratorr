import type { ImportCardAnnotation } from '@/components/manual-import';
import type { DiscoveredBook } from '@/lib/api';
import { makeRelativePath } from '@/lib/pathUtils.js';
import { libraryImportSection } from './libraryImportSection.js';

/**
 * #2091's display rule, owned by the surface that needs it rather than by the shared card.
 *
 * States the observed fact only. The edit-modal escape hatch force-imports past the confirm
 * ladder, so any wording promising a recording check at import would be false for that path.
 */
export function buildCopyAnnotation(
  book: DiscoveredBook,
  libraryRoot: string,
): ImportCardAnnotation | null {
  if (libraryImportSection(book) !== 'duplicate-copy') return null;

  // An incumbent outside the configured root has no relative spelling; show it whole rather than
  // dropping the one fact the row exists to convey. Classify on the trimmed value so a
  // whitespace-only path degrades instead of rendering `Same recording as    `.
  const display = book.existingPath
    ? makeRelativePath(book.existingPath, libraryRoot) ?? book.existingPath
    : '';

  return {
    badge: { label: 'Duplicate copy', variant: 'warning' },
    note: display.trim()
      ? `Same recording as ${display}`
      : 'Same recording as a book already in your library',
  };
}
