import { eq, and, isNull, ne, sql, inArray } from 'drizzle-orm';
import type { DbOrTx } from '../../db/index.js';
import { books, seriesMembers } from '../../db/schema.js';
import { normalizeSeriesName } from '../utils/series-normalize.js';
import type { BookMetadata } from '../../core/metadata/index.js';

/**
 * Single source of truth for primary-author normalization used by both
 * logical-identity grouping during refresh AND existing-row lookup in
 * `findExistingMemberId()` / `BookService.upsertSeriesLink()`. Returns
 * null for null/empty/whitespace, otherwise lowercased + alphanumeric-
 * runs-to-single-spaces (the same normalization used for titles). (F12)
 */
export function normalizePrimaryAuthor(name: string | null | undefined): string | null {
  if (name == null) return null;
  const trimmed = name.trim();
  if (trimmed === '') return null;
  return normalizeSeriesName(trimmed);
}

/**
 * Identity used to scope a same-series refresh to the targeted series. Prefer
 * `asin` (Audible series ASIN) when available — it's the strongest identifier
 * since two series can share a normalized name across providers. The
 * `normalizedName` is the dedupe-friendly form computed by `normalizeSeriesName`.
 * Either field can be null; matching is best-effort across whatever the caller
 * could derive from the seed book, the existing series row, and request opts. (#1078)
 */
export interface TargetSeriesIdentity {
  asin: string | null;
  normalizedName: string | null;
}

export interface MatchedSeriesRef {
  name: string;
  asin: string | null;
  position: number | null;
}

/**
 * Strip a leading `the ` so series names like `Stormlight Archive` and
 * `The Stormlight Archive` cross-match. The leading article gets dropped at
 * surface-form boundaries by various metadata sources (Audible vs Hardcover
 * vs hand-typed `book.seriesName`), so a strict-equality compare on
 * `normalizeSeriesName` output misses real same-series matches. This helper
 * is intentionally local to cross-source matching — the strict
 * `normalizeSeriesName` is still what DB `series.normalized_name` rows store,
 * so we don't introduce a migration or break existing lookup indexes. (#1078)
 */
function looseNormalize(normalized: string): string {
  return normalized.startsWith('the ') ? normalized.slice(4) : normalized;
}

/**
 * Find the `series` ref on a provider product that belongs to the target
 * series. Returns the matched ref (with name/asin/position) or `null` when the
 * product is not a member of the target series. Provider series ASIN match
 * wins over normalized-name match; we never fall back to `product.series[0]`
 * because that's the bug shape from #1078 — a multi-series book on Audible
 * commonly lists a broader universe (e.g. `The Cosmere`) before the actual
 * target series, and importing the universe ref would pollute the card with
 * unrelated members and wrong positions. (#1078)
 */
export function findMatchingSeriesRef(
  product: BookMetadata,
  target: TargetSeriesIdentity,
): MatchedSeriesRef | null {
  if (!product.series || product.series.length === 0) return null;
  if (target.asin) {
    const byAsin = product.series.find((s) => s.asin && s.asin === target.asin);
    if (byAsin) return toMatchedRef(byAsin);
  }
  if (target.normalizedName) {
    const targetLoose = looseNormalize(target.normalizedName);
    const byName = product.series.find((s) => {
      if (typeof s.name !== 'string' || s.name.length === 0) return false;
      const candidate = normalizeSeriesName(s.name);
      return candidate === target.normalizedName || looseNormalize(candidate) === targetLoose;
    });
    if (byName) return toMatchedRef(byName);
  }
  return null;
}

function toMatchedRef(ref: { name?: string | undefined; asin?: string | undefined; position?: number | undefined }): MatchedSeriesRef {
  const validPosition = ref.position != null && Number.isFinite(ref.position) ? ref.position : null;
  return {
    name: ref.name ?? '',
    asin: ref.asin ?? null,
    position: validPosition,
  };
}

export function buildMemberValues(
  seriesId: number,
  product: BookMetadata,
  matchedRef: MatchedSeriesRef,
  alternateAsins: string[],
): typeof seriesMembers.$inferInsert {
  const { position } = matchedRef;
  return {
    seriesId,
    providerBookId: product.asin ?? null,
    alternateAsins: [...alternateAsins].sort(),
    title: product.title,
    normalizedTitle: normalizeSeriesName(product.title),
    authorName: product.authors[0]?.name ?? null,
    positionRaw: position !== null ? String(position) : null,
    position,
    publishedDate: product.publishedDate ?? null,
    coverUrl: product.coverUrl ?? null,
    duration: product.duration ?? null,
    publisher: product.publisher ?? null,
    source: 'provider',
    lastSeenAt: new Date(),
    updatedAt: new Date(),
  };
}

/**
 * Locate an existing series_members row that matches the candidate's logical
 * identity. Tries (1) direct providerBookId match, (2) candidateAsin present
 * in any row's alternate_asins, (3) the (seriesId + normalizedTitle +
 * positionRaw + normalizedAuthor) fallback. The fallback runs even when
 * candidateAsin is non-null so a canonical-ASIN flip on the next refresh
 * still finds the existing row instead of inserting a duplicate. Single
 * helper to keep refresh and BookService.upsertSeriesLink() in lockstep. (F12)
 */
export async function findMemberByLogicalIdentity(
  db: DbOrTx,
  seriesId: number,
  normalizedTitle: string,
  positionRaw: string | null,
  normalizedAuthor: string | null,
  candidateAsin: string | null,
): Promise<number | null> {
  if (candidateAsin) {
    const direct = await db
      .select({ id: seriesMembers.id })
      .from(seriesMembers)
      .where(and(eq(seriesMembers.seriesId, seriesId), eq(seriesMembers.providerBookId, candidateAsin)))
      .limit(1);
    if (direct[0]) return direct[0].id;
    const viaAlternate = await db
      .select({ id: seriesMembers.id })
      .from(seriesMembers)
      .where(and(
        eq(seriesMembers.seriesId, seriesId),
        sql`EXISTS (SELECT 1 FROM json_each(${seriesMembers.alternateAsins}) WHERE value = ${candidateAsin})`,
      ))
      .limit(1);
    if (viaAlternate[0]) return viaAlternate[0].id;
  }
  const positionFilter = positionRaw !== null
    ? eq(seriesMembers.positionRaw, positionRaw)
    : isNull(seriesMembers.positionRaw);
  // Author comparison happens in-memory via the shared `normalizePrimaryAuthor`
  // helper. Don't prefilter with `lower(author_name)` — that would exclude
  // rows whose stored display author needs trim/punctuation/space-run
  // normalization to match (e.g. `'  Nicholas Eames  '`, `'J. R. R. Tolkien'`).
  // The (seriesId + normalizedTitle + positionRaw) prefilter keeps the row set
  // bounded (single-digit rows per series entry). (F12, #1075 F1)
  const rows = await db
    .select({ id: seriesMembers.id, authorName: seriesMembers.authorName })
    .from(seriesMembers)
    .where(and(
      eq(seriesMembers.seriesId, seriesId),
      eq(seriesMembers.normalizedTitle, normalizedTitle),
      positionFilter,
    ));
  for (const row of rows) {
    if (normalizePrimaryAuthor(row.authorName) === normalizedAuthor) return row.id;
  }
  return null;
}

export async function upsertCanonicalMember(
  db: DbOrTx,
  seriesId: number,
  product: BookMetadata,
  matchedRef: MatchedSeriesRef,
  alternateAsins: string[],
): Promise<number> {
  const values = buildMemberValues(seriesId, product, matchedRef, alternateAsins);
  const normalizedAuthor = normalizePrimaryAuthor(product.authors[0]?.name ?? null);
  const existingId = await findMemberByLogicalIdentity(
    db,
    seriesId,
    values.normalizedTitle,
    values.positionRaw ?? null,
    normalizedAuthor,
    product.asin ?? null,
  );
  if (existingId !== null) {
    await db.update(seriesMembers).set({ ...values, seriesId }).where(eq(seriesMembers.id, existingId));
    return existingId;
  }
  const inserted = await db.insert(seriesMembers).values(values).returning({ id: seriesMembers.id });
  return inserted[0]!.id;
}

export async function linkLocalBooksByAsin(db: DbOrTx, seriesId: number): Promise<void> {
  // Match on canonical providerBookId OR any entry in alternate_asins, so the
  // local library link resolves even when the owned book's ASIN was collapsed
  // into a canonical row under a different ASIN. (F12)
  const unlinked = await db
    .select({
      id: seriesMembers.id,
      providerBookId: seriesMembers.providerBookId,
      alternateAsins: seriesMembers.alternateAsins,
    })
    .from(seriesMembers)
    .where(and(eq(seriesMembers.seriesId, seriesId), isNull(seriesMembers.bookId)));
  for (const member of unlinked) {
    const asins: string[] = [];
    if (member.providerBookId) asins.push(member.providerBookId);
    for (const alt of member.alternateAsins ?? []) {
      if (alt) asins.push(alt);
    }
    if (asins.length === 0) continue;
    for (const asin of asins) {
      const bookRows = await db.select({ id: books.id }).from(books).where(eq(books.asin, asin)).limit(1);
      if (bookRows.length > 0) {
        await db
          .update(seriesMembers)
          .set({ bookId: bookRows[0]!.id, updatedAt: new Date() })
          .where(eq(seriesMembers.id, member.id));
        break;
      }
    }
  }
}

interface CandidateInfo {
  product: BookMetadata;
  matchedRef: MatchedSeriesRef;
  normalizedTitle: string;
  positionRaw: string | null;
  normalizedAuthor: string | null;
}

function logicalGroupKey(c: CandidateInfo): string {
  return `${c.positionRaw ?? '∅'}|${c.normalizedTitle}|${c.normalizedAuthor ?? '∅'}`;
}

function describeCandidate(product: BookMetadata, matchedRef: MatchedSeriesRef): CandidateInfo {
  const { position } = matchedRef;
  return {
    product,
    matchedRef,
    normalizedTitle: normalizeSeriesName(product.title),
    positionRaw: position !== null ? String(position) : null,
    normalizedAuthor: normalizePrimaryAuthor(product.authors[0]?.name ?? null),
  };
}

function metadataRichness(product: BookMetadata): number {
  let score = 0;
  if (product.coverUrl) score += 1;
  if (product.duration != null) score += 1;
  if (product.publishedDate) score += 1;
  if (product.publisher) score += 1;
  return score;
}

async function pickCanonical(db: DbOrTx, group: CandidateInfo[], seedAsin: string): Promise<CandidateInfo> {
  // 1. Seed/current book ASIN
  const seedMatch = group.find((c) => c.product.asin === seedAsin);
  if (seedMatch) return seedMatch;
  // 2. ASIN already matches a local library book
  for (const c of group) {
    if (!c.product.asin) continue;
    const rows = await db.select({ id: books.id }).from(books).where(eq(books.asin, c.product.asin)).limit(1);
    if (rows.length > 0) return c;
  }
  // 3. Richest metadata, with deterministic lexically-smallest-ASIN tiebreaker
  return [...group].sort((a, b) => {
    const diff = metadataRichness(b.product) - metadataRichness(a.product);
    if (diff !== 0) return diff;
    const aAsin = a.product.asin ?? '￿';
    const bAsin = b.product.asin ?? '￿';
    return aAsin.localeCompare(bAsin);
  })[0]!;
}

/**
 * Detect and clean up pre-existing stale logical-duplicate rows in the same
 * series that match the canonical row's logical identity but are different
 * rows. The prior ASIN-only dedupe could create these. For each stale row:
 * migrate its bookId (if canonical has none), fold its providerBookId +
 * alternate_asins into the canonical's alternate_asins, then delete. (F12)
 */
async function cleanupLogicalDuplicates(
  db: DbOrTx,
  canonicalId: number,
  seriesId: number,
  c: CandidateInfo,
): Promise<void> {
  const positionFilter = c.positionRaw !== null
    ? eq(seriesMembers.positionRaw, c.positionRaw)
    : isNull(seriesMembers.positionRaw);
  const candidates = await db
    .select({
      id: seriesMembers.id,
      bookId: seriesMembers.bookId,
      providerBookId: seriesMembers.providerBookId,
      authorName: seriesMembers.authorName,
      alternateAsins: seriesMembers.alternateAsins,
    })
    .from(seriesMembers)
    .where(and(
      eq(seriesMembers.seriesId, seriesId),
      eq(seriesMembers.normalizedTitle, c.normalizedTitle),
      positionFilter,
      ne(seriesMembers.id, canonicalId),
    ));
  const stale = candidates.filter((row) => normalizePrimaryAuthor(row.authorName) === c.normalizedAuthor);
  if (stale.length === 0) return;
  const canonicalRow = await db
    .select({
      bookId: seriesMembers.bookId,
      providerBookId: seriesMembers.providerBookId,
      alternateAsins: seriesMembers.alternateAsins,
    })
    .from(seriesMembers)
    .where(eq(seriesMembers.id, canonicalId))
    .limit(1);
  if (canonicalRow.length === 0) return;
  let bookId: number | null = canonicalRow[0]!.bookId;
  const mergedAlts = new Set<string>(canonicalRow[0]!.alternateAsins ?? []);
  const canonicalAsin = canonicalRow[0]!.providerBookId;
  for (const row of stale) {
    if (bookId === null && row.bookId !== null) bookId = row.bookId;
    if (row.providerBookId && row.providerBookId !== canonicalAsin) mergedAlts.add(row.providerBookId);
    for (const alt of row.alternateAsins ?? []) {
      if (alt && alt !== canonicalAsin) mergedAlts.add(alt);
    }
    await db.delete(seriesMembers).where(eq(seriesMembers.id, row.id));
  }
  await db
    .update(seriesMembers)
    .set({ bookId, alternateAsins: [...mergedAlts].sort(), updatedAt: new Date() })
    .where(eq(seriesMembers.id, canonicalId));
}

/**
 * Filter a same-series response down to the products that actually belong to
 * the target series. Returns the `CandidateInfo` describing each matching
 * product with its matched series ref so callers don't need to re-run the
 * match. Used by `reconcileCandidates` and surfaced separately so the helper
 * layer can detect the empty-filtered case before opening a transaction. (#1078)
 */
export function filterProductsToTarget(
  products: BookMetadata[],
  target: TargetSeriesIdentity,
): CandidateInfo[] {
  const candidates: CandidateInfo[] = [];
  for (const product of products) {
    const ref = findMatchingSeriesRef(product, target);
    if (ref === null) continue;
    candidates.push(describeCandidate(product, ref));
  }
  return candidates;
}

/** ASINs of products in `products` that did NOT match the target series. */
function collectNonMatchingAsins(products: BookMetadata[], target: TargetSeriesIdentity): string[] {
  const out: string[] = [];
  for (const product of products) {
    if (!product.asin) continue;
    if (findMatchingSeriesRef(product, target) === null) out.push(product.asin);
  }
  return out;
}

/**
 * Delete pre-existing members in the target series whose providerBookId is
 * also one of the non-matching products in the response. These are the
 * contaminated rows from the prior buggy refresh path (#1078) — a book that
 * Audible now explicitly places in a different series cannot simultaneously
 * be a legit member here, so it's safe to drop. Limited to providerBookId
 * matches (no alternate_asins sweep) to keep the blast radius bounded.
 */
async function deleteContaminatedMembers(
  tx: DbOrTx,
  seriesId: number,
  nonMatchingAsins: string[],
): Promise<void> {
  if (nonMatchingAsins.length === 0) return;
  await tx
    .delete(seriesMembers)
    .where(and(
      eq(seriesMembers.seriesId, seriesId),
      inArray(seriesMembers.providerBookId, nonMatchingAsins),
    ));
}

/**
 * Logical-identity dedupe: filter candidates to the target series, group by
 * (position + normalized title + normalized author), pick a canonical product
 * per group, persist non-canonical ASINs as alternate_asins on the canonical
 * row, then sweep any pre-existing stale logical-duplicate rows. Replaces the
 * prior ASIN-only dedupe which left alternate Audible editions as duplicate
 * logical rows AND failed to converge on existing stale rows. (F12, #1073)
 *
 * Filtering to the target identity must happen BEFORE logical grouping —
 * otherwise unrelated products from a broader Audible "universe" series can
 * share a (position + title + author) key with a legit target-series member
 * and collapse into the wrong bucket. (#1078)
 */
export async function reconcileCandidates(
  tx: DbOrTx,
  seriesId: number,
  products: BookMetadata[],
  target: TargetSeriesIdentity,
  seedAsin: string,
): Promise<void> {
  // Drop pre-existing members that the new response explicitly puts in a
  // different series (i.e. they're in `products` but not target-matching).
  // This is what reconciles a contaminated row back to scope on refresh. (#1078)
  await deleteContaminatedMembers(tx, seriesId, collectNonMatchingAsins(products, target));

  const candidates = filterProductsToTarget(products, target);
  const groups = new Map<string, CandidateInfo[]>();
  for (const c of candidates) {
    const key = logicalGroupKey(c);
    const existing = groups.get(key);
    if (existing) existing.push(c);
    else groups.set(key, [c]);
  }
  for (const group of groups.values()) {
    // Defensive ASIN-only dedupe inside each logical group (#1073).
    const seenAsin = new Set<string>();
    const uniqueByAsin: CandidateInfo[] = [];
    for (const c of group) {
      const asin = c.product.asin;
      if (asin) {
        if (seenAsin.has(asin)) continue;
        seenAsin.add(asin);
      }
      uniqueByAsin.push(c);
    }
    const canonical = await pickCanonical(tx, uniqueByAsin, seedAsin);
    const alternateAsins = uniqueByAsin
      .filter((c) => c !== canonical && c.product.asin && c.product.asin !== canonical.product.asin)
      .map((c) => c.product.asin as string);
    const canonicalId = await upsertCanonicalMember(tx, seriesId, canonical.product, canonical.matchedRef, alternateAsins);
    await cleanupLogicalDuplicates(tx, canonicalId, seriesId, canonical);
  }
}
