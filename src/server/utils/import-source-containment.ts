import { dirname, isAbsolute, parse, relative } from 'node:path';
import { canonicalPath } from './path-identity.js';

export type ImportSourceRefusal =
  | 'source_is_filesystem_root'
  | 'source_inside_library'
  | 'source_contains_library';

export type ImportSourceVerdict =
  | { admissible: true }
  | { admissible: false; reason: ImportSourceRefusal; message: string };

/**
 * Operator-facing copy: the route sends these straight into a toast (`useBookActions.ts`), so they
 * name the condition in the operator's vocabulary rather than the classifier's.
 */
const REFUSAL_MESSAGES: Record<ImportSourceRefusal, string> = {
  source_is_filesystem_root:
    'Source path is a whole filesystem root — pick the folder or file that holds the book, not the entire drive',
  // Verbatim pre-#2478 route copy; an existing operator-visible contract.
  source_inside_library: 'Source path is inside the library root — it is already managed by the library',
  source_contains_library:
    'Source path contains the library root — importing a folder that holds your library would pull its own managed files back in',
};

/**
 * Path-shape based rather than a `'/'` literal, so a Windows drive root answers too. The two
 * predicates are cross-checks of one another: `dirname(c) === c` is true only at a root, and
 * `parse(c).root === c` states the same thing from the parser's side.
 */
function isFilesystemRoot(canonical: string): boolean {
  return dirname(canonical) === canonical && parse(canonical).root === canonical;
}

function refuse(reason: ImportSourceRefusal): ImportSourceVerdict {
  return { admissible: false, reason, message: REFUSAL_MESSAGES[reason] };
}

/**
 * #2478 — may this source be imported into the library at `libraryRoot`?
 *
 * One definition for two callers (the Import Files route and `orchestrateCopy`) so they cannot
 * drift: the route's refusal and the worker's re-validation are the same decision made twice, and
 * a queued job must not be able to bypass what the route refused.
 *
 * Classification order is fixed — filesystem-root, then inside-library, then contains-library — so
 * a source that trips two (`/` while the library is `/audiobooks`) answers deterministically. The
 * root check precedes the missing-library early return on purpose: an install with no library path
 * configured must still refuse a whole filesystem.
 *
 * Both operands go through `canonicalPath` (fold → resolve → fold), so a `..` segment spelled with
 * backslashes cannot survive into the comparison. Deliberately LEXICAL: a source that is a symlink
 * pointing at the library root is not addressed here.
 *
 * Note the inside-library arm treats an empty relative path as INSIDE, which is the opposite of
 * `isOutsideRoot` in `paths.ts` — that helper backs `assertPathInsideLibrary`, which requires a
 * strict descendant. Reading the library root itself as importable is exactly the hole this rule
 * exists to close, so the two cannot share an implementation.
 */
export function classifyImportSource(
  sourcePath: string,
  libraryRoot: string | null | undefined,
): ImportSourceVerdict {
  const source = canonicalPath(sourcePath);
  if (isFilesystemRoot(source)) return refuse('source_is_filesystem_root');

  const configuredRoot = libraryRoot?.trim();
  if (!configuredRoot) return { admissible: true };
  const library = canonicalPath(configuredRoot);

  const sourceFromLibrary = relative(library, source);
  if (sourceFromLibrary === '' || (!sourceFromLibrary.startsWith('..') && !isAbsolute(sourceFromLibrary))) {
    return refuse('source_inside_library');
  }

  // Strict descendant only: equality already answered above.
  const libraryFromSource = relative(source, library);
  if (libraryFromSource !== '' && !libraryFromSource.startsWith('..') && !isAbsolute(libraryFromSource)) {
    return refuse('source_contains_library');
  }

  return { admissible: true };
}
