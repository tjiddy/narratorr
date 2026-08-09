import { normalize, resolve, relative } from 'node:path';
import { buildTargetPath } from './import-helpers.js';
import type { NamingOptions } from '@core/utils/naming.js';

/** Fields consumed by buildTargetPath; narrator order must match full-book queries. */
export interface FolderTargetRow {
  path: string;
  title: string;
  seriesName?: string | null | undefined;
  seriesPosition?: number | null | undefined;
  narrators?: Array<{ name: string }> | null | undefined;
  publishedDate?: string | null | undefined;
  /** Feeds the `{edition}` token and collision suffix. */
  editionLabel?: string | null | undefined;
}

export interface LibraryFolderSettings {
  path: string;
  folderFormat: string;
}

/** Shared preview/apply target calculation with normalized Windows-stored paths. */
export function computeFolderTarget(
  row: FolderTargetRow,
  authorName: string | null,
  library: LibraryFolderSettings,
  namingOptions: NamingOptions,
): { targetPath: string; changed: boolean } {
  const targetPath = buildTargetPath(library.path, library.folderFormat, row, authorName, namingOptions, row.editionLabel);
  const normalizedCurrent = normalize(resolve(row.path.split('\\').join('/')));
  const normalizedTarget = normalize(resolve(targetPath));
  return { targetPath, changed: normalizedCurrent !== normalizedTarget };
}

/** Return a POSIX library-relative path, or the original when outside the root. */
export function toLibraryRelative(absPath: string, libraryRoot: string): string {
  const rel = relative(normalize(resolve(libraryRoot)), normalize(resolve(absPath)));
  if (!rel || rel.startsWith('..')) return absPath;
  return rel.split('\\').join('/');
}
