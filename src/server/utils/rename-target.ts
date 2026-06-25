import { normalize, resolve, relative } from 'node:path';
import { buildTargetPath } from './import-helpers.js';
import type { NamingOptions } from '../../core/utils/naming.js';

/**
 * Row shape needed to compute a book's folder target. Mirrors the fields
 * `buildTargetPath` reads from a book — including ordered `narrators` so the
 * `{narrator}`/`{narratorLastFirst}` folder tokens render identically whether the
 * caller is `planRename` (full book from `getById`) or the bulk count/preview/job
 * (projected DB rows). `path` is the book's current absolute folder path.
 */
export interface FolderTargetRow {
  path: string;
  title: string;
  seriesName?: string | null | undefined;
  seriesPosition?: number | null | undefined;
  narrators?: Array<{ name: string }> | null | undefined;
  publishedDate?: string | null | undefined;
}

export interface LibraryFolderSettings {
  path: string;
  folderFormat: string;
}

/**
 * Single source of truth for "where should this book's folder live, and does that
 * differ from where it is now?". Consumed by `planRename`, the bulk count/preview,
 * and the bulk rename job so the preview can never disagree with the apply.
 *
 * Backslash-stored paths (Windows imports) are normalized to POSIX before the
 * comparison, matching how the bulk count has always compared paths.
 */
export function computeFolderTarget(
  row: FolderTargetRow,
  authorName: string | null,
  library: LibraryFolderSettings,
  namingOptions: NamingOptions,
): { targetPath: string; changed: boolean } {
  const targetPath = buildTargetPath(library.path, library.folderFormat, row, authorName, namingOptions);
  const normalizedCurrent = normalize(resolve(row.path.split('\\').join('/')));
  const normalizedTarget = normalize(resolve(targetPath));
  return { targetPath, changed: normalizedCurrent !== normalizedTarget };
}

/**
 * Convert an absolute folder path to its library-root-relative form, using
 * POSIX separators for parity with how paths are stored and rendered elsewhere.
 * Falls back to the original path if it's not actually inside the library root.
 */
export function toLibraryRelative(absPath: string, libraryRoot: string): string {
  const rel = relative(normalize(resolve(libraryRoot)), normalize(resolve(absPath)));
  if (!rel || rel.startsWith('..')) return absPath;
  return rel.split('\\').join('/');
}
