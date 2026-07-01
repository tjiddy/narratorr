/**
 * Duplicate-resolution primitives for the three-way `BookService.findDuplicate`
 * (#1711). Extracted from `book.service.ts` to keep that file under the line cap;
 * holds the typed owned-recording error, the candidate/resolution shapes, the
 * create-time ASIN unique-violation matcher, and the adapters that map between
 * service rows and the core recording resolver's plain-primitive shapes.
 */

import { eq, and, sql, notExists } from 'drizzle-orm';
import { slugify } from '../../core/index.js';
import { resolveRecordingIdentity, type RecordingCandidate, type LibraryRecording, type RecordingVerdict, type RecordingReviewReason } from '../../core/utils/recording-identity.js';
import { normalizeTitleForDedup } from '../../shared/dedup.js';
import { canonicalizeAsin } from '../../shared/asin.js';
import { books, authors, bookAuthors } from '../../db/schema.js';
import type { Db } from '../../db/index.js';
import type { BookWithAuthor } from './book.service.js';
import type { ForcedImportRefusedReason } from '../../shared/schemas/sse-events.js';

/** Hydrate a book row by id — the `BookService.getById` bound method. */
type GetByIdFn = (id: number) => Promise<BookWithAuthor | null>;

// `books.asin` carries a partial unique index (`idx_books_asin_unique` on the
// non-null column). A create-time race (two writers inserting the same ASIN
// between the dedupe check and the insert) still throws a SQLite UNIQUE
// violation; detect it the way enrichment.ts/book-import.service.ts do — both
// the index-name and column-message forms, checking `error.cause?.message`
// first since Drizzle/libSQL nests the SQLite message under `.cause`.
export const ASIN_UNIQUE_VIOLATION = /UNIQUE constraint failed.*(?:idx_books_asin_unique|books\.asin)/;

/**
 * Typed fail-closed error for a recording that is already owned (#1711). Mirrors
 * the `RenameError` idiom: a typed throw rather than a silent owner-return so an
 * unmapped caller surfaces a loud error instead of enqueuing import work against
 * an already-owned book. Carries the incumbent's id/title so route handlers can
 * build a 409 body and import callers can log/skip.
 */
export class OwnedRecordingError extends Error {
  readonly code = 'OWNED_RECORDING' as const;
  readonly existingBookId: number;
  readonly bookTitle: string;
  readonly reason: string;
  constructor(args: { existingBookId: number; title: string; reason: string }) {
    super(`Recording already owned by book #${args.existingBookId} (${args.reason})`);
    this.name = 'OwnedRecordingError';
    this.existingBookId = args.existingBookId;
    this.bookTitle = args.title;
    this.reason = args.reason;
  }
}

/**
 * Map an `OwnedRecordingError` raised by the copy-time collision fence into the
 * structured `forced-import-refused` discriminator (#1736). The fence's ownerless
 * throw sites (`recording-review-no-disambiguator`, `recording-review-disambiguated-collision`
 * with zero path owners) carry the `-1` sentinel rather than a real incumbent id, so
 * any non-positive/absent id maps to `null` — the user-facing reason never reports
 * "book #-1". Single-/2+-owner throws carry a real `owners[0].id` and keep it.
 */
export function buildForcedImportRefusedReason(error: OwnedRecordingError): ForcedImportRefusedReason {
  return {
    kind: 'forced-import-refused',
    recordingReason: error.reason,
    existingBookId: error.existingBookId > 0 ? error.existingBookId : null,
  };
}

/** Candidate identity for the 3-way duplicate resolution (#1711). */
export interface DuplicateCandidate {
  title: string;
  authors?: { name: string; asin?: string | undefined }[] | undefined;
  asin?: string | undefined;
  narrators?: string[] | undefined;
  duration?: number | null | undefined;
  /**
   * Canonical production form (#1728). Forwarded to the resolver's
   * production-type veto; callers that hold no production-form signal omit it.
   */
  productionType?: string | null | undefined;
}

export type DuplicateVerdict = RecordingVerdict;

/**
 * Three-way duplicate resolution (#1711). `book` is the owning incumbent for
 * `same-recording`, a representative review incumbent for `review`, or `null`
 * for `different-recording` (a genuinely new recording).
 */
export interface DuplicateResolution {
  verdict: DuplicateVerdict;
  book: BookWithAuthor | null;
  /**
   * True iff ≥1 plausible incumbent was gathered in the bibliographic scope
   * (#1712). Additive and orthogonal to `verdict`/`book`: it disambiguates the two
   * `different-recording` cases — a genuinely NEW book (no incumbents,
   * `hasIncumbent: false`) vs. a different recording of an OWNED title (incumbents
   * existed but none resolved to same/review, `hasIncumbent: true`). `book` keeps
   * its `different-recording ⇒ null` contract; consumers that read only
   * `verdict`/`book` are unaffected.
   */
  hasIncumbent: boolean;
  /**
   * Machine reason a `review` verdict was reached (#1728) — forwarded verbatim
   * from the resolver result for the representative review incumbent. Populated
   * only when `verdict === 'review'`. The single channel callers use to log/record
   * *why* a review was held; no caller recomputes the production-type comparison.
   * Distinct from the user-facing display string `reviewReason` (`match-job`).
   */
  recordingReviewReason?: RecordingReviewReason;
}

/** Adapt a candidate identity into the core resolver's plain-primitive shape. */
export function toRecordingCandidate(c: DuplicateCandidate): RecordingCandidate {
  return {
    title: c.title,
    authors: (c.authors ?? []).map((a) => a.name),
    narrators: c.narrators ?? [],
    asin: c.asin ?? null,
    duration: c.duration ?? null,
    productionType: c.productionType ?? null,
  };
}

/** Adapt a hydrated library row into the core resolver's library-recording shape. */
export function toLibraryRecording(b: BookWithAuthor): LibraryRecording {
  return {
    title: b.title,
    primaryAuthorSlug: slugify(b.authors[0]?.name ?? ''),
    narrators: b.narrators.map((n) => n.name),
    asin: b.asin ?? null,
    duration: b.duration ?? null,
    productionType: b.productionType ?? null,
  };
}

/**
 * Gather the ids of every plausible incumbent in the bibliographic scope (#1711).
 * Multi-narration means a normalized title + primary-author slug can legitimately
 * match more than one row, so this returns ALL of them (no `limit(1)`). The three
 * branches mirror the pre-#1711 ordered identity contract: (1) ASIN
 * case-insensitive, (2) normalized-title + position-0 author slug, (3) author-less
 * exact title-only with the #253 notExists guard.
 */
async function gatherIncumbentIds(db: Db, candidate: DuplicateCandidate): Promise<number[]> {
  const ids = new Set<number>();

  // Canonicalize the candidate ASIN ONCE (trim + UPPERCASE → null on blank, #1733)
  // so a padded/case-drifted pre-write candidate (`' B01ABC '`) still finds the
  // stored canonical row, and so the resolver (which canonicalizes identically,
  // #1729) and this gather site cannot drift on the padded/blank-ASIN decision.
  const canonicalAsin = canonicalizeAsin(candidate.asin);

  // (1) ASIN — canonical compare against the stored upper(asin) (matches the durable
  // upper(asin) unique index), ALL hits. Same upper(asin) + canonicalizeAsin fold as
  // findAsinCollision (the aligning sibling). findLibraryStatusByAsins is also
  // case-insensitive but folds on lower(asin), so it is not the fold-direction precedent.
  if (canonicalAsin) {
    const byAsin = await db.select({ id: books.id }).from(books)
      .where(eq(sql`upper(${books.asin})`, canonicalAsin));
    for (const r of byAsin) ids.add(r.id);
  }

  // (2) normalized title + position-0 author slug — ALL hits. Title normalization
  // is not SQLite-expressible, so fetch by author slug and compare in app code.
  const authorList = candidate.authors;
  if (authorList && authorList.length > 0) {
    const primarySlug = slugify(authorList[0]!.name);
    const byAuthor = await db.select({ id: books.id, title: books.title }).from(books)
      .innerJoin(bookAuthors, and(eq(bookAuthors.bookId, books.id), eq(bookAuthors.position, 0)))
      .innerJoin(authors, eq(bookAuthors.authorId, authors.id))
      .where(eq(authors.slug, primarySlug));
    const wanted = normalizeTitleForDedup(candidate.title);
    for (const row of byAuthor) {
      if (normalizeTitleForDedup(row.title) === wanted) ids.add(row.id);
    }
  }

  // (3) Author-less exact title-only when no authors and no ASIN (#246). Only
  // zero-author rows so authored "Shogun" doesn't block authorless "Shogun" (#253).
  // Uses the canonical ASIN so a blank/whitespace candidate ASIN counts as "no ASIN".
  if (!canonicalAsin && (!authorList || authorList.length === 0)) {
    const byTitle = await db.select({ id: books.id }).from(books)
      .where(and(
        eq(books.title, candidate.title),
        notExists(db.select({ id: bookAuthors.bookId }).from(bookAuthors).where(eq(bookAuthors.bookId, books.id))),
      ));
    for (const r of byTitle) ids.add(r.id);
  }

  return [...ids];
}

/**
 * Three-way, multi-incumbent-aware duplicate resolution (#1711). Gathers every
 * plausible incumbent, runs `resolveRecordingIdentity` over each, and applies the
 * precedence ladder: any `same-recording` ⇒ owned (order-independent); else any
 * `review`/no-signal ⇒ review; else all `different-recording` ⇒ a new recording.
 */
export async function resolveDuplicate(db: Db, getById: GetByIdFn, candidate: DuplicateCandidate): Promise<DuplicateResolution> {
  const ids = await gatherIncumbentIds(db, candidate);
  // No incumbents at all → a genuinely new book (hasIncumbent: false).
  if (ids.length === 0) return { verdict: 'different-recording', book: null, hasIncumbent: false };

  const recordingCandidate = toRecordingCandidate(candidate);
  let reviewBook: BookWithAuthor | null = null;
  let reviewReason: RecordingReviewReason | undefined;
  for (const id of ids) {
    const book = await getById(id);
    if (!book) continue;
    const { verdict, recordingReviewReason } = resolveRecordingIdentity(recordingCandidate, toLibraryRecording(book));
    if (verdict === 'same-recording') return { verdict: 'same-recording', book, hasIncumbent: true };
    if (verdict === 'review' && !reviewBook) {
      reviewBook = book;
      reviewReason = recordingReviewReason;
    }
  }
  if (reviewBook) return { verdict: 'review', book: reviewBook, hasIncumbent: true, ...(reviewReason && { recordingReviewReason: reviewReason }) };
  // Incumbents existed but none matched → a different recording of an owned title.
  return { verdict: 'different-recording', book: null, hasIncumbent: true };
}

/**
 * Return EVERY library row whose stored `path` equals the given normalized path
 * (#1711) — the cardinality input for the occupied-target collision fence.
 * `books.path` is indexed but NOT unique, so callers branch on 0 / 1 / 2+.
 *
 * `books.path` is stored in POSIX form (`buildTargetPath` emits forward slashes so
 * the library DB is portable across the Linux runtime and Windows dev boxes). Callers
 * pass `normalize(resolve(...))`, which is backslash-separated on Windows — so the
 * exact-match `eq` below would MISS the row there (0 owners → a same-recording
 * re-import wrongly disambiguates into a new `(edition)` folder instead of a staged
 * swap). POSIX-fold the key so the comparison is POSIX-vs-POSIX on every platform (#1752).
 */
export async function findPathOwners(db: Db, getById: GetByIdFn, normalizedPath: string): Promise<BookWithAuthor[]> {
  const posixPath = normalizedPath.split('\\').join('/');
  const rows = await db.select({ id: books.id }).from(books).where(eq(books.path, posixPath));
  const owners: BookWithAuthor[] = [];
  for (const r of rows) {
    const book = await getById(r.id);
    if (book) owners.push(book);
  }
  return owners;
}
