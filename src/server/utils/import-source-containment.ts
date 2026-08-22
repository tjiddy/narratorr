import { realpath } from 'node:fs/promises';
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
 * One definition for three callers (the Import Files route, `orchestrateCopy`, and the automatic
 * download-client pipeline's `runImportCommit`) so they cannot drift: the route's refusal, the
 * worker's re-validation and the auto pipeline's mapped-save-path check are the same decision made
 * three times, and a queued job must not be able to bypass what the route refused.
 *
 * Classification order is fixed — filesystem-root, then inside-library, then contains-library — so
 * a source that trips two (`/` while the library is `/audiobooks`) answers deterministically. The
 * root check precedes the missing-library early return on purpose: an install with no library path
 * configured must still refuse a whole filesystem.
 *
 * Both operands go through `canonicalPath` (fold → resolve → fold), so a `..` segment spelled with
 * backslashes cannot survive into the comparison.
 *
 * #2538 made the rule two layers rather than converting it. This function is the pure, lexical,
 * table-testable core; `classifyImportSourceResolved` below is the symlink-aware wrapper every call
 * site actually uses. Callers wanting a verdict about what is really on disk want that one.
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

/**
 * #2538 — the same rule, applied to what the operands really point at.
 *
 * Three steps, in this order: run the lexical rule; return an inadmissible verdict unchanged having
 * touched NO filesystem; otherwise resolve both operands and re-run the lexical rule on the resolved
 * pair. The short-circuit is load-bearing at the route, where `/` must be refused before anything
 * walks it.
 *
 * The verdict vocabulary is deliberately unchanged: a symlinked source answers with the class of the
 * path it RESOLVES to, so the operator sees the same three codes and the same copy.
 *
 * ENOENT on either operand falls back to the lexical verdict rather than throwing — `validateSource`
 * owns the operator-facing remote-path-mapping guidance for a missing source, and an install whose
 * library root does not exist on disk yet must not have every import throw. Any other realpath error
 * propagates. This mirrors `assertRealPathInsideLibrary` (`paths.ts`), the primitive #2517 named.
 *
 * BOTH operands resolve, never one: a library root that is itself a link (the macOS `/var` →
 * `/private/var` shape) silently flips verdicts under one-sided resolution. Both resolved values go
 * back through `canonicalPath` — re-running the lexical rule is what does that — so the
 * fold-before-resolve property holds on the resolved pair as well as the raw one.
 */
export async function classifyImportSourceResolved(
  sourcePath: string,
  libraryRoot: string | null | undefined,
): Promise<ImportSourceVerdict> {
  const lexical = classifyImportSource(sourcePath, libraryRoot);
  if (!lexical.admissible) return lexical;

  const configuredRoot = libraryRoot?.trim();
  let resolvedSource: string;
  let resolvedRoot: string | null = null;
  try {
    resolvedSource = await realpath(sourcePath);
    if (configuredRoot) resolvedRoot = await realpath(configuredRoot);
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return lexical;
    throw error;
  }

  return classifyImportSource(resolvedSource, resolvedRoot);
}
