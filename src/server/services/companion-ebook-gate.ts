import type { CompanionEbookExposureInput } from '@shared/companion-ebook-exposure.js';
import type { BookService } from './book.service.js';
import type { SettingsService } from './settings.service.js';
import type { CompanionEbookRow } from './types.js';

// ============================================================================
// The companion read-gate ladder, at one site (#2013)
// ============================================================================
//
// Two surfaces run the same eight rungs and then answer in two different error
// vocabularies: the owner file routes (`src/server/routes/companion-ebook.ts`) speak
// `{ error: '<message>' }`, the public v1 stream (`src/server/routes/v1/companion-ebook.ts`)
// speaks the frozen `{ error: { code, message } }` envelope and collapses every book-shaped
// negative into one `404 companion_epub_unavailable` so an API-key consumer cannot use the
// endpoint as an existence oracle.
//
// This module owns the DECISION and nothing else. It takes no `FastifyReply` and constructs
// no reply body — that reply-free signature is what keeps the two vocabularies out of shared
// code, and the services/routes layer rule (`eslint.config.js`) already forbids the import
// that would let it cheat.

/**
 * Why every rejection is a named arm rather than a bare `null`: the semantic distinction is
 * what makes the ladder reviewable. No caller is obliged to map them distinctly — v1 folds all
 * four book-shaped arms into one response on purpose.
 *
 * Rungs 2 and 3 deliberately SHARE `no_book`. Both surfaces already answer them identically,
 * and telling "no such publicId" apart from "publicId resolved, row gone" at the v1 boundary is
 * exactly the existence oracle the frozen contract forbids.
 */
export type CompanionEbookGateRejection =
  /** Rung 1 — `companionEpub.enabled` is false. The only non-book-shaped arm. */
  | 'disabled'
  /** Rung 2 or 3 — the identity did not resolve, or the book row is gone. */
  | 'no_book'
  /** Rung 5 — the injected exposure predicate said no. */
  | 'not_exposed'
  /** Rung 6 — the observation carries no stored basename. */
  | 'no_file'
  /** Rung 7 — `books.path` is null, empty, or whitespace-only. */
  | 'no_path';

/** Everything a companion file needs to be opened, once the row is known readable. */
export interface CompanionEbookGateContext {
  /**
   * The resolved rowid. Part of the context because the helper owns rungs 2-3, so the v1
   * caller no longer holds it — and its success tail needs it four times over
   * (`openCompanionEbook`, `triggerCompanionReconcile`, the `{ bookId, outcome }` boundary
   * record, and `streamCompanionEbook`). Returning it is also what keeps rung 2 a pure read:
   * the alternative — a thunk that stashes the id in a closure the caller reads afterwards —
   * makes the resolved identity an out-of-band side effect. The owner adapter discards it.
   */
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
  /**
   * Rung 2 — resolve the numeric book id, invoked only AFTER the flag read.
   *
   * A thunk rather than a `bookId` parameter because #1975 AC6 requires the feature-flag read
   * to precede every book-existence read: a disabled server must not be probeable for whether a
   * `publicId` exists. v1 passes its `resolveByPublicId` call; the owner adapter passes
   * `async () => id` and issues no read at all. Reading the flag at both layers instead would
   * re-spell the first rung this helper exists to single-home.
   *
   * It resolves an IDENTITY only — loading the row is rung 3, which the helper owns because the
   * predicate needs `book.status` and the context needs `book.path`.
   */
  resolveBookId: () => Promise<number | null>;
  /** Rung 4 — `findCompanionEbook(db, bookId)`, injected so the read is assertable on its own. */
  findObservation: (bookId: number) => Promise<CompanionEbookRow | null>;
  /**
   * Rung 5 — one of the two named exports from `@shared/companion-ebook-exposure.js`, never a
   * raw status list and never an inline `enabled && imported && <status set>`.
   *
   * The three owner file routes pass `isCompanionEbookOwnerReadable`; the v1 stream passes
   * `isCompanionEbookExposed`. Hard-coding either one here breaks a surface: the owner gate
   * would make the public stream serve a `drm_protected` row it must not advertise (a DRM'd
   * EPUB genuinely fails Amazon's converter), and the advertisement gate would deny the owner a
   * misclassified-DRM file — the exact regression #2038 shipped to fix.
   */
  isExposed: (input: CompanionEbookExposureInput) => boolean;
}

/**
 * **The** companion read-gate decision, for both the owner file routes and the public v1
 * stream (#2013).
 *
 * Runs eight rungs in this order, each short-circuiting: no rung after a rejection runs at all,
 * so no read is issued and the predicate is never called.
 *
 * 1. `settings.get('companionEpub')` → `enabled` — else `disabled`
 * 2. the injected identity thunk — `null` → `no_book`
 * 3. `bookService.getById` — `null` → `no_book`
 * 4. the injected observation read — absence is not a rejection; rung 5 decides
 * 5. the injected exposure predicate — false → `not_exposed`
 * 6. `observation?.filename` truthiness — else `no_file`
 * 7. non-blank `books.path` — else `no_path`
 * 8. `settings.get('library')` → `path`
 *
 * **Side-effect-free beyond those reads.** It takes no logger and no reconciler, so it cannot
 * log and cannot enqueue: gate rejections are unlogged on both surfaces today, and
 * `triggerCompanionReconcile` stays at the post-gate call sites because the reconciler calls
 * the resolver from inside its own non-reentrant `withBookAdmissionLock` (#1960 AC29). Moving
 * either in here would add an API-key-reachable side effect and log records to the public route.
 *
 * **Dependency failures propagate; they are never rejection arms.** None of the five reads is
 * wrapped in a `try`/`catch`, so an infrastructure fault reaches each surface's generic handler
 * as its own `500` rather than being reported as a contract-level "this book has no ebook".
 * Note how that interacts with short-circuiting: for a book whose row is gone, rung 4's query is
 * never issued, so a database fault there is unobservable and the surface answers its
 * book-shaped `404`. Reordering rung 4 ahead of rung 3 would turn that same request into a
 * `500`.
 *
 * `isCompanionEbookEligible` is deliberately NOT consulted: its filesystem term stats the book
 * DIRECTORY, while the opener's containment check on the FILE is the authority. That is a
 * decision both shipped ladders made, not an oversight.
 */
export async function evaluateCompanionEbookGate(
  deps: CompanionEbookGateDeps,
): Promise<CompanionEbookGateResult> {
  // Rung 1 — FIRST, ahead of every book-existence read (#1975 AC6). `SettingsService.get` may
  // itself hit the `settings` table on a cold cache; "no DB read at all" is not satisfiable and
  // is not what the no-oracle property needs.
  const { enabled } = await deps.settingsService.get('companionEpub');
  if (!enabled) return { rejection: 'disabled' };

  // Rung 2 — identity only.
  const bookId = await deps.resolveBookId();
  if (bookId === null) return { rejection: 'no_book' };

  // Rung 3 — the row whose `status` rung 5 tests and whose `path` rung 7 and the context read.
  const book = await deps.bookService.getById(bookId);
  if (!book) return { rejection: 'no_book' };

  // Rung 4 — absence is not a rejection here; the predicate treats a missing row as false.
  const observation = await deps.findObservation(bookId);

  // Rung 5 — `enabled` is threaded back in even though it is redundant after the early return:
  // it is the predicate's declared contract, and re-spelling the terms is the drift the two
  // named gates exist to prevent.
  if (!deps.isExposed({ enabled, bookStatus: book.status, observationStatus: observation?.status })) {
    return { rejection: 'not_exposed' };
  }

  // Rungs 6 and 7 narrow nullable columns that `ck_companion_ebooks_file_present` already makes
  // non-null for every status either gate admits — unreachable in practice, expressible in the
  // type. The ASYMMETRY between them is deliberate and must not be tidied: `books.path` gets a
  // `trim()` test, `filename` does not. A truthy but non-persistable stored basename — a padded
  // `' book.epub'`, a `sub/book.epub`, a dot segment — MUST pass this rung and reach the opener,
  // whose `isPersistableCompanionBasename` check is the single validation authority and carries
  // the `invalid_filename` outcome plus its warn and its one reconcile enqueue. A trim or
  // basename guard here would silently delete both of those.
  const filename = observation?.filename;
  if (!filename) return { rejection: 'no_file' };
  if (!book.path || book.path.trim() === '') return { rejection: 'no_path' };

  // Rung 8 — inside the helper, so it still completes BEFORE the v1 handler's
  // `semaphore.tryAcquire()` (#1975 AC20). Ordered the other way, a rejecting read strands a
  // slot permanently and the route answers `503` forever after N rejections.
  const { path: libraryRoot } = await deps.settingsService.get('library');
  return { context: { bookId, bookPath: book.path, filename, libraryRoot } };
}
