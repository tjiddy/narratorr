import { stat } from 'node:fs/promises';
import type { FastifyBaseLogger } from 'fastify';
import type { BookStatus } from '@shared/schemas/book.js';
import { assertPathInsideLibrary, PathOutsideLibraryError } from '../utils/paths.js';
import { serializeError } from '../utils/serialize-error.js';

export interface CompanionEligibilityInput {
  enabled: boolean;
  book: { id: number; status: BookStatus; path: string | null };
  libraryRoot: string;
}

/**
 * Fail closed unless an imported book path is a directory strictly inside the library root.
 * Containment is deliberately lexical: operator-created symlinked book folders are allowed;
 * serve-time checks enforce containment on the file itself.
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
    // Expected control flow omits the error field.
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
    log.debug(
      { bookId: book.id, path: book.path, error: serializeError(error) },
      'Companion ebook directory probe failed — treating book as ineligible',
    );
    return false;
  }
}
