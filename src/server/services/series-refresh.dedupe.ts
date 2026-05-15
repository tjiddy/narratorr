import { eq, and, isNull, ne, sql, inArray } from 'drizzle-orm';
import type { DbOrTx } from '../../db/index.js';
import { books, seriesMembers } from '../../db/schema.js';
import { normalizeSeriesName } from '../utils/series-normalize.js';
import type { BookMetadata } from '../../core/metadata/index.js';
// `pickCanonical`, the scoring helpers, and `filterRadioFormatType` live in
// `series-refresh.canonical.ts` to keep this file under the project max-lines
// budget. Re-exported below so existing imports of `filterRadioFormatType` from
// the dedupe module keep working. (#1116)
import { filterRadioFormatType, pickCanonical } from './series-refresh.canonical.js';
export { filterRadioFormatType };

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
 * Strip well-known Audible edition / split-part / adaptation / omnibus suffixes
 * from a product title before normalization so noisy variants collapse into the
 * same logical-work slot on the Series card. Conservative: parens/brackets must
 * match the explicit descriptor patterns; new omnibus/edition/collection/bundle
 * /complete/box-set keywords are anchored to end-of-title (suffix) so real work
 * titles whose stem contains the keyword (e.g. `The Complete Sherlock Holmes`,
 * `Box of Bones`, `Edition Wars`) are preserved. Operates on product title only
 * — subtitle is intentionally out of scope (#1126). (#1116, #1126)
 */
const EDITION_SUFFIX_PATTERNS: RegExp[] = [
  /\(\s*(?:part\s+)?\d+\s+of\s+\d+\s*\)/gi,
  /\(\s*dramatized[^)]*\)/gi,
  /\(\s*unabridged\s*\)/gi,
  /\(\s*abridged\s*\)/gi,
  /\(\s*original\s+recording\s*\)/gi,
  /\[\s*(?:part\s+)?\d+\s+of\s+\d+\s*\]/gi,
  /\[\s*dramatized[^\]]*\]/gi,
  /\[\s*unabridged\s*\]/gi,
  /\[\s*abridged\s*\]/gi,
  /\[\s*original\s+recording\s*\]/gi,
  // Trailing parenthetical/bracket containing an integer range like
  // `(Wool 1 - 5)` or `[Books 1 - 3]`. Anchored to end-of-title to avoid
  // chewing through legitimate parentheticals earlier in the string. (#1126)
  /\s*\(\s*[^)]*?\d+\s*[-–]\s*\d+[^)]*?\)\s*$/i,
  /\s*\[\s*[^\]]*?\d+\s*[-–]\s*\d+[^\]]*?\]\s*$/i,
  // Trailing edition/container/bundle keywords. Anchored to end so the
  // negative cases (`The Complete Sherlock Holmes`, `Box of Bones`,
  // `Edition Wars`) never strip. Optional leading `the` matches the
  // `: The Complete Collection` shape after a colon/dash. (#1126)
  /[\s:,\-–]+(?:the\s+)?(?:omnibus|edition|collection|bundle|complete)\s*$/i,
  /[\s:,\-–]+(?:the\s+)?box\s+set\s*$/i,
];

export function normalizeSeriesMemberWorkTitle(title: string): string {
  // Iterate so stacked suffixes like `Wool Omnibus Edition` collapse fully:
  // pass 1 strips ` Edition`, pass 2 strips ` Omnibus`. Capped by string-shrink
  // monotonicity — every successful match shortens `stripped`, so termination
  // is guaranteed within O(title.length) iterations. (#1126)
  let stripped = title;
  let prev: string;
  do {
    prev = stripped;
    for (const pattern of EDITION_SUFFIX_PATTERNS) {
      stripped = stripped.replace(pattern, ' ');
    }
  } while (stripped !== prev);
  return normalizeSeriesName(stripped);
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
  // When the candidate has an Audnexus-derived `seriesPrimary`, it is the
  // canonical primary-series identity for that book. The membership-validation
  // rule (#1088 F1) requires `seriesPrimary` to match the target — a
  // non-matching primary means the candidate is at best a secondary/universe
  // member of the target series (e.g. Cosmere-only primary while the target is
  // Stormlight) and must NOT fall through to the raw Audible `series[]` match.
  // That fallback is reserved for candidates whose Audnexus enrichment was
  // unavailable (no `seriesPrimary` field), where `series[]` is the only
  // signal we have. (#1088 F1 / PR #1091 F1)
  if (product.seriesPrimary) {
    if (target.asin && product.seriesPrimary.asin === target.asin) {
      return toMatchedRef(product.seriesPrimary);
    }
    if (target.normalizedName && typeof product.seriesPrimary.name === 'string' && product.seriesPrimary.name.length > 0) {
      const candidate = normalizeSeriesName(product.seriesPrimary.name);
      const targetLoose = looseNormalize(target.normalizedName);
      if (candidate === target.normalizedName || looseNormalize(candidate) === targetLoose) {
        return toMatchedRef(product.seriesPrimary);
      }
    }
    return null;
  }
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
    normalizedTitle: normalizeSeriesMemberWorkTitle(product.title),
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
  normalizedWorkTitle: string,
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
  // Work-title equality is computed in-memory against the stored `title` column,
  // not via a SQL `eq(normalizedTitle, ...)` clause — otherwise pre-#1116 stale
  // rows whose stored `normalizedTitle` was the noisy `normalizeSeriesName(title)`
  // form would fall outside the SQL filter even when their title's work-title
  // form matches the candidate. Author comparison is also in-memory; the
  // (seriesId + positionRaw) prefilter keeps the row set bounded (single-digit
  // rows per series-position). (#1116 F1, F12, #1075 F1)
  const rows = await db
    .select({ id: seriesMembers.id, title: seriesMembers.title, authorName: seriesMembers.authorName })
    .from(seriesMembers)
    .where(and(
      eq(seriesMembers.seriesId, seriesId),
      positionFilter,
    ));
  for (const row of rows) {
    if (normalizeSeriesMemberWorkTitle(row.title) !== normalizedWorkTitle) continue;
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
    // Monotonic union: never let the persisted alternate_asins shrink across
    // refreshes. Fold in the existing row's alternates AND, when the canonical
    // ASIN has flipped, capture the displaced providerBookId as an alternate so
    // reachability via the old ASIN doesn't regress. The new canonical's own
    // ASIN is removed from the set — it must never appear as its own
    // alternate. (#1116 F3, F4)
    const existing = await db
      .select({
        providerBookId: seriesMembers.providerBookId,
        alternateAsins: seriesMembers.alternateAsins,
      })
      .from(seriesMembers)
      .where(eq(seriesMembers.id, existingId))
      .limit(1);
    const existingRow = existing[0];
    const merged = new Set<string>(existingRow?.alternateAsins ?? []);
    for (const a of alternateAsins) merged.add(a);
    const newCanonicalAsin = product.asin ?? null;
    if (existingRow?.providerBookId && existingRow.providerBookId !== newCanonicalAsin) {
      merged.add(existingRow.providerBookId);
    }
    if (newCanonicalAsin) merged.delete(newCanonicalAsin);
    values.alternateAsins = [...merged].sort();
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

export interface CandidateInfo {
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
    normalizedTitle: normalizeSeriesMemberWorkTitle(product.title),
    positionRaw: position !== null ? String(position) : null,
    normalizedAuthor: normalizePrimaryAuthor(product.authors[0]?.name ?? null),
  };
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
  // Scan the whole series rather than narrowing by position, so an orphaned
  // omnibus/container row that landed at `position: null` is also caught and
  // folded into the numbered canonical with the same normalized work title.
  // The in-memory work-title + author equality below is the load-bearing
  // identity check. (#1126)
  const candidates = await db
    .select({
      id: seriesMembers.id,
      bookId: seriesMembers.bookId,
      providerBookId: seriesMembers.providerBookId,
      title: seriesMembers.title,
      authorName: seriesMembers.authorName,
      positionRaw: seriesMembers.positionRaw,
      alternateAsins: seriesMembers.alternateAsins,
    })
    .from(seriesMembers)
    .where(and(
      eq(seriesMembers.seriesId, seriesId),
      ne(seriesMembers.id, canonicalId),
    ));
  // Cleanup direction is asymmetric: a null-position canonical never outranks
  // a numbered row, so we MUST NOT delete a numbered row when the current
  // canonical is null-position. Otherwise a refresh whose response carries
  // only a null-position container would promote that container past the
  // numberless filter by displacing a healthy numbered row from a prior
  // refresh. (#1126 PR #1127 F1)
  const stale = candidates.filter((row) => {
    if (normalizeSeriesMemberWorkTitle(row.title) !== c.normalizedTitle) return false;
    if (normalizePrimaryAuthor(row.authorName) !== c.normalizedAuthor) return false;
    if (c.positionRaw === null && row.positionRaw !== null) return false;
    return true;
  });
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

  // Strip radio-play / original-recording editions before grouping, unless the
  // seed itself carries that format (the Hitchhiker radio-play exception). (#1088 F3)
  const formatFiltered = filterRadioFormatType(products, seedAsin);
  const candidates = filterProductsToTarget(formatFiltered, target);
  const groups = new Map<string, CandidateInfo[]>();
  for (const c of candidates) {
    const key = logicalGroupKey(c);
    const existing = groups.get(key);
    if (existing) existing.push(c);
    else groups.set(key, [c]);
  }
  // When a null-position group shares its normalized work title + author with
  // a numbered group in the SAME refresh, fold the null-position candidates
  // into the numbered group BEFORE canonical selection. Without this merge the
  // null-position group would upsert as its own canonical, and the widened
  // cleanup scan would then treat the numbered clean row as stale and delete
  // it — violating the null-position contract (#1126 PR #1127 F1). The
  // numbered position is authoritative; the null-position container's ASIN
  // becomes an alternate on the numbered canonical, preserving local-import
  // linkability.
  const numberedKeyByTitleAuthor = new Map<string, string>();
  for (const [key, group] of groups) {
    const sample = group[0]!;
    if (sample.positionRaw !== null) {
      const titleAuthor = `${sample.normalizedTitle}|${sample.normalizedAuthor ?? '∅'}`;
      if (!numberedKeyByTitleAuthor.has(titleAuthor)) {
        numberedKeyByTitleAuthor.set(titleAuthor, key);
      }
    }
  }
  for (const [key, group] of [...groups]) {
    const sample = group[0]!;
    if (sample.positionRaw !== null) continue;
    const titleAuthor = `${sample.normalizedTitle}|${sample.normalizedAuthor ?? '∅'}`;
    const numberedKey = numberedKeyByTitleAuthor.get(titleAuthor);
    if (numberedKey && numberedKey !== key) {
      groups.get(numberedKey)!.push(...group);
      groups.delete(key);
    }
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
