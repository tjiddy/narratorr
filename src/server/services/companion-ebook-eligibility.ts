import { stat } from 'node:fs/promises';
import type { FastifyBaseLogger } from 'fastify';
import type { BookStatus } from '@shared/schemas/book.js';
import { assertPathInsideLibrary, PathOutsideLibraryError } from '../utils/paths.js';
import { serializeError } from '../utils/serialize-error.js';

export interface CompanionEligibilityInput {
  /** `companionEpub.enabled`, read by the CALLER from `SettingsService.get('companionEpub')`. */
  enabled: boolean;
  book: { id: number; status: BookStatus; path: string | null };
  /** `settings.library.path`, read by the CALLER. */
  libraryRoot: string;
}

/**
 * Can this book carry a companion ebook at all? (#1958, plan §2.)
 *
 * Evaluates, in this order and short-circuiting on the first `false`:
 * feature enabled · `book.status === 'imported'` · a non-empty (post-`trim`) `book.path` ·
 * a non-empty (post-`trim`) `libraryRoot` · the path is a strict descendant of the root ·
 * the path `stat`s to a directory. Only the last gate touches the filesystem.
 *
 * **Fails closed** on every negative and every error — a null/blank path, a blank root, a
 * path outside or equal to the root, a file rather than a directory, and any fs errno
 * (`ENOENT`, `EACCES`, `ENOTDIR`, `EIO`, `ESTALE`) or a `code`-less throw. No exception
 * escapes.
 *
 * Containment is NOT reimplemented here: `assertPathInsideLibrary` already owns that
 * decision (normalize + resolve + `relative`, rejecting root-equality, `..` escapes,
 * sibling-prefix attacks, and cross-drive paths). What is forbidden is a raw
 * `bookPath.startsWith(libraryRoot)` prefix comparison; the `rel.startsWith('..')` test
 * *inside* that helper is the correct idiom and is exactly what this guard adopts.
 *
 * **Explicit non-goal:** the LEXICAL `assertPathInsideLibrary`, never the symlink-aware
 * `assertRealPathInsideLibrary`, and the stored path is never `realpath`ed. A symlinked
 * book folder pointing outside the root is operator-placed, not attacker-influenced
 * (SECURITY.md — filesystem browsing is intentionally unrestricted), and the serve-time
 * authority is 1.5's `lstat` + containment on the *file*. This is a decision, not an
 * oversight — do not "upgrade" it.
 *
 * `enabled` and `libraryRoot` are supplied by the caller so the guard reads no settings
 * itself and stays testable with no service mock. `book.id` is carried solely so the
 * failure log matches the `{ bookId, path }` shape `library-scan.service.ts` already emits.
 *
 * Returns a plain boolean: no reason codes, nothing user-facing — the panel is simply
 * absent where the feature does not apply.
 */
export async function isCompanionEbookEligible(
  input: CompanionEligibilityInput,
  log: FastifyBaseLogger,
): Promise<boolean> {
  const { enabled, book, libraryRoot } = input;
  if (!enabled) return false;
  if (book.status !== 'imported') return false;
  if (!book.path || book.path.trim() === '') return false;
  if (libraryRoot.trim() === '') return false;

  try {
    assertPathInsideLibrary(book.path, libraryRoot);
  } catch (error: unknown) {
    // Expected control-flow outcome, not a failure — logged without an `error:` key.
    if (error instanceof PathOutsideLibraryError) {
      log.debug({ bookId: book.id, path: book.path }, 'Book path outside library root — companion ebook ineligible');
      return false;
    }
    log.debug(
      { bookId: book.id, path: book.path, error: serializeError(error) },
      'Companion ebook containment check failed',
    );
    return false;
  }

  try {
    const stats = await stat(book.path);
    return stats.isDirectory();
  } catch (error: unknown) {
    // Same level, shape, and raw-path treatment `classifyProbeFailure` already uses for
    // the identical class of event — no redaction beyond existing convention.
    log.debug(
      { bookId: book.id, path: book.path, error: serializeError(error) },
      'Companion ebook directory probe failed — treating book as ineligible',
    );
    return false;
  }
}
