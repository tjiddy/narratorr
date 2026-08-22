import { ImportCard, type ImportRow } from '@/components/manual-import';
import { makeRelativePath } from '@/lib/pathUtils.js';
import { buildCopyAnnotation } from './copyAnnotation.js';

interface DuplicateCopiesSectionProps {
  rows: ImportRow[];
  libraryRoot: string;
  onEdit: (row: ImportRow) => void;
  paused?: boolean | undefined;
}

/**
 * #2091 — folders holding a recording the library already owns at a DIFFERENT path.
 *
 * Deliberately outside the "N existing" toggle: unlike a folder that IS a book's own path, this is
 * orphaned disk the operator can act on, and hiding it by default is how it stayed invisible.
 * Rows stay unselectable (import would refuse them anyway); the edit affordance is the override.
 */
export function DuplicateCopiesSection({ rows, libraryRoot, onEdit, paused }: DuplicateCopiesSectionProps) {
  if (rows.length === 0) return null;

  return (
    <section data-testid="duplicate-copies-section" className="border-t border-white/5">
      <div className="px-4 py-2.5 border-b border-white/5">
        <p className="text-xs font-medium text-amber-500/80">
          Duplicate copies at other paths
        </p>
        <p className="text-xs text-muted-foreground/50 mt-0.5">
          {rows.length} folder{rows.length !== 1 ? 's' : ''} holding a recording your library already
          has somewhere else. Nothing is imported or deleted — review and clean up on disk.
        </p>
      </div>
      <div className="max-h-[35vh] overflow-y-auto divide-y divide-white/5">
        {rows.map((row) => (
          <ImportCard
            key={row.book.path}
            row={row}
            onEdit={() => onEdit(row)}
            lockDuplicates
            annotation={buildCopyAnnotation(row.book, libraryRoot) ?? undefined}
            relativePath={makeRelativePath(row.book.path, libraryRoot)}
            paused={paused}
          />
        ))}
      </div>
    </section>
  );
}
