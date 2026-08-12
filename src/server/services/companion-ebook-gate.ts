import type { CompanionEbookExposureInput } from '@shared/companion-ebook-exposure.js';
import type { BookService } from './book.service.js';
import type { SettingsService } from './settings.service.js';
import type { CompanionEbookRow } from './types.js';

// Shared decision only; owner and public routes retain their incompatible error envelopes.
// Identity miss and vanished row share no_book so v1 cannot become an existence oracle.
export type CompanionEbookGateRejection =
  | 'disabled'
  | 'no_book'
  | 'not_exposed'
  | 'no_file'
  | 'no_path';

export interface CompanionEbookGateContext {
  bookId: number;
  bookPath: string;
  filename: string;
  libraryRoot: string;
}

export type CompanionEbookGateResult =
  | { context: CompanionEbookGateContext }
  | { rejection: CompanionEbookGateRejection };

export interface CompanionEbookGateDeps {
  settingsService: Pick<SettingsService, 'get'>;
  bookService: Pick<BookService, 'getById'>;
  /** Thunk enforces flag-before-identity ordering; it resolves only the id, never the row. */
  resolveBookId: () => Promise<number | null>;
  findObservation: (bookId: number) => Promise<CompanionEbookRow | null>;
  /** Surface predicate: owner may read DRM-classified rows that public v1 must not advertise. */
  isExposed: (input: CompanionEbookExposureInput) => boolean;
}

/**
 * Shared short-circuit ladder: rejected rungs perform no later reads. Dependency failures
 * propagate as 500s, never rejection arms. Keep logging/reconciliation post-gate to avoid public
 * side effects and lock re-entry. The opener's file containment, not directory eligibility, is authoritative.
 */
export async function evaluateCompanionEbookGate(
  deps: CompanionEbookGateDeps,
): Promise<CompanionEbookGateResult> {
  // Feature flag must precede book reads; a settings DB read itself reveals no book identity.
  const { enabled } = await deps.settingsService.get('companionEpub');
  if (!enabled) return { rejection: 'disabled' };

  const bookId = await deps.resolveBookId();
  if (bookId === null) return { rejection: 'no_book' };

  const book = await deps.bookService.getById(bookId);
  if (!book) return { rejection: 'no_book' };

  // Missing observation flows to the surface predicate.
  const observation = await deps.findObservation(bookId);

  // Pass the predicate's full contract instead of restating its terms here.
  if (!deps.isExposed({ enabled, bookStatus: book.status, observationStatus: observation?.status })) {
    return { rejection: 'not_exposed' };
  }

  // Keep filename truthiness-only: invalid basenames must reach the opener's single validation path.
  // book.path is intentionally trimmed; making these checks symmetric loses warning/reconcile behavior.
  const filename = observation?.filename;
  if (!filename) return { rejection: 'no_file' };
  if (!book.path || book.path.trim() === '') return { rejection: 'no_path' };

  // Finish all reads before v1 acquires its semaphore; rejection after acquisition would leak a slot.
  const { path: libraryRoot } = await deps.settingsService.get('library');
  return { context: { bookId, bookPath: book.path, filename, libraryRoot } };
}
