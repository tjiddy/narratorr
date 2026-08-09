import { eq, and, sql, notExists } from 'drizzle-orm';
import { slugify } from '@core/index.js';
import { resolveRecordingIdentity, type RecordingCandidate, type LibraryRecording, type RecordingVerdict, type RecordingReviewReason } from '@core/utils/recording-identity.js';
import { buildTitleShape, titlesMatchForDedup } from '@shared/dedup.js';
import { canonicalizeAsin } from '@shared/asin.js';
import { books, authors, bookAuthors } from '@db/schema.js';
import type { Db } from '@db/index.js';
import type { BookWithAuthor } from './book.service.js';
import type { ForcedImportRefusedReason } from '@shared/schemas/sse-events.js';

type GetByIdFn = (id: number) => Promise<BookWithAuthor | null>;

// Create-time ASIN races surface as index-name or column UNIQUE messages, often under cause.
export const ASIN_UNIQUE_VIOLATION = /UNIQUE constraint failed.*(?:idx_books_asin_unique|books\.asin)/;

// Fail closed so unmapped callers cannot enqueue against an owned book; fields support 409 responses.
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

// Ownerless collision fences use -1; never expose that sentinel as an incumbent id.
export function buildForcedImportRefusedReason(error: OwnedRecordingError): ForcedImportRefusedReason {
  return {
    kind: 'forced-import-refused',
    recordingReason: error.reason,
    existingBookId: error.existingBookId > 0 ? error.existingBookId : null,
  };
}

export interface DuplicateCandidate {
  title: string;
  authors?: { name: string; asin?: string | undefined }[] | undefined;
  asin?: string | undefined;
  narrators?: string[] | undefined;
  duration?: number | null | undefined;
  /** Canonical form for the resolver's production-type veto. */
  productionType?: string | null | undefined;
}

export type DuplicateVerdict = RecordingVerdict;

// book is the owner for same-recording, review representative, or null for different-recording.
export interface DuplicateResolution {
  verdict: DuplicateVerdict;
  book: BookWithAuthor | null;
  /** Distinguishes a new book from a different recording of an owned title. */
  hasIncumbent: boolean;
  /** Resolver machine reason for review; distinct from match-job display text. */
  recordingReviewReason?: RecordingReviewReason;
}

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

// Gather all plausible incumbents: canonical ASIN, title+primary author, then authorless exact.
// Subtitle matching is non-transitive, so retain every hit and return ascending ids.
async function gatherIncumbentIds(db: Db, candidate: DuplicateCandidate): Promise<number[]> {
  const ids = new Set<number>();

  // Canonicalize once so query and resolver share the padded/blank-ASIN decision.
  const canonicalAsin = canonicalizeAsin(candidate.asin);

  // Compare upper(asin) to match the durable unique index; keep every hit.
  if (canonicalAsin) {
    const byAsin = await db.select({ id: books.id }).from(books)
      .where(eq(sql`upper(${books.asin})`, canonicalAsin));
    for (const r of byAsin) ids.add(r.id);
  }

  // Non-transitive title matching requires every pairwise primary-author hit, not limit(1).
  const authorList = candidate.authors;
  if (authorList && authorList.length > 0) {
    const primarySlug = slugify(authorList[0]!.name);
    const byAuthor = await db.select({ id: books.id, title: books.title }).from(books)
      .innerJoin(bookAuthors, and(eq(bookAuthors.bookId, books.id), eq(bookAuthors.position, 0)))
      .innerJoin(authors, eq(bookAuthors.authorId, authors.id))
      .where(eq(authors.slug, primarySlug));
    const wanted = buildTitleShape(candidate.title);
    for (const row of byAuthor) {
      if (titlesMatchForDedup(buildTitleShape(row.title), wanted)) ids.add(row.id);
    }
  }

  // Without canonical ASIN/authors, exact title may match only zero-author rows.
  if (!canonicalAsin && (!authorList || authorList.length === 0)) {
    const byTitle = await db.select({ id: books.id }).from(books)
      .where(and(
        eq(books.title, candidate.title),
        notExists(db.select({ id: bookAuthors.bookId }).from(bookAuthors).where(eq(bookAuthors.bookId, books.id))),
      ));
    for (const r of byTitle) ids.add(r.id);
  }

  // Ascending ids make the review representative deterministic; same-recording remains order-independent.
  return [...ids].sort((a, b) => a - b);
}

// Precedence across all incumbents: any same-recording, else first review, else different-recording.
export async function resolveDuplicate(db: Db, getById: GetByIdFn, candidate: DuplicateCandidate): Promise<DuplicateResolution> {
  const ids = await gatherIncumbentIds(db, candidate);
  if (ids.length === 0) return { verdict: 'different-recording', book: null, hasIncumbent: false };

  const recordingCandidate = toRecordingCandidate(candidate);
  let reviewBook: BookWithAuthor | null = null;
  let reviewReason: RecordingReviewReason | undefined;
  for (const id of ids) {
    const book = await getById(id);
    if (!book) continue;
    const { verdict, recordingReviewReason } = resolveRecordingIdentity(recordingCandidate, toLibraryRecording(book));
    if (verdict === 'same-recording') return { verdict: 'same-recording', book, hasIncumbent: true };
    // First review is the lowest-id representative because ids are ascending.
    if (verdict === 'review' && !reviewBook) {
      reviewBook = book;
      reviewReason = recordingReviewReason;
    }
  }
  if (reviewBook) return { verdict: 'review', book: reviewBook, hasIncumbent: true, ...(reviewReason && { recordingReviewReason: reviewReason }) };
  return { verdict: 'different-recording', book: null, hasIncumbent: true };
}

// Paths are non-unique, so return all owners for the 0/1/2+ collision fence.
// Storage is POSIX but Windows normalize returns backslashes; fold them or same-path re-imports
// miss owners and create an edition folder instead of staging a swap.
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
