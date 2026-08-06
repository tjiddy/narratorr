import type { BookMetadata } from '@core/metadata/index.js';
import { pickPrimarySeries } from '@shared/pick-primary-series.js';
import type { OpfMetadata } from '../utils/opf-reader.js';
import type { ImportConfirmItem } from './library-scan.service.js';
import type { NarratorSource } from './import-adapters/types.js';

/**
 * The `metadata.opf` → staged-item overlay (#2158).
 *
 * narratorr has written a faithful export of every curated field into each managed book folder since
 * #1668, but the import path never read it — so narrator corrections, descriptions, genres and
 * publishers regenerated from provider data on every drop-and-reimport. This module is the read half
 * of that round-trip: it folds a parsed sidecar into the staged item, and classifies the item's
 * narrator provenance for the tag gate downstream.
 *
 * The ladder is **OPF → embedded tags → provider metadata**, and the split between what the overlay
 * does and what it must NOT do follows the fields:
 *
 * - **Descriptive fields the folder cannot carry** (subtitle, description, publisher, publishedDate,
 *   genres) ride `metadata` and the OPF **overrides** the provider — those are precisely the values
 *   the operator corrected.
 * - **Narrators** replace top-level `item.narrators` outright. Writing them into
 *   `metadata.narrators` would be silently lost: `buildBookCreatePayload` reads
 *   `item.narrators?.length ? item.narrators : meta?.narrators`, and for an auto-matched row
 *   `item.narrators` is always non-empty (the provider copy at `buildEditedFromBestMatch`).
 * - **Folder-carried fields** (title, author, series, position) are corroborated, never overridden.
 *   The physical folder arrangement is the operator's most deliberate act at import time.
 * - **Identifiers** are last-resort only, so an OPF ASIN can never outrank an explicit item ASIN or a
 *   matched provider ASIN at dedupe/create time.
 */

/** A folder author is "present" only when it survives a trim — the same test `resolveImportSeries` uses. */
function hasAuthorName(item: ImportConfirmItem): boolean {
  return !!item.authorName?.trim();
}

/**
 * Same length, same elements, same order, compared after `trim()`.
 *
 * This is the whole of D8's "still the provider's own proposal" question — no inference about who
 * typed what, just whether the two arrays in the payload still agree.
 */
function sameNarrators(own: string[], provider: string[]): boolean {
  return own.length === provider.length && own.every((name, i) => name.trim() === provider[i]!.trim());
}

/**
 * Classify the item's narrators per D8's three-value table, evaluated in that order.
 *
 * The OPF arm is evaluated FIRST, which is what makes "the OPF always wins over anything on the
 * wire" true without an OPF-vs-wire cross-product: a user-typed narrator does not outrank the
 * sidecar, and it should not, since re-importing a managed folder is precisely a request to restore
 * what the folder says.
 *
 * A CLEARED narrator field classifies as `none` and stays refillable by tags or the provider. That
 * is a known, deliberate limitation: `BookEditModal` omits `narrators` entirely when the field is
 * emptied, so a deliberate clear is byte-identical to a field that was never populated. Durable
 * clears are the tombstone mechanism's job (`userClearedFields`, #2152); the OPF carries no
 * tombstones, so a re-imported book starts tombstone-free by design.
 */
export function classifyNarratorSource(item: ImportConfirmItem, opf: OpfMetadata | null): NarratorSource {
  if (opf?.narrators.length) return 'curated';
  const own = item.narrators ?? [];
  if (own.length === 0) return 'none';
  return sameNarrators(own, item.metadata?.narrators ?? []) ? 'provider' : 'curated';
}

/** The OPF's series as a metadata series ref; `position` is omitted (never nulled) when absent. */
function opfSeriesRef(opf: OpfMetadata): { name: string; position?: number } {
  return {
    name: opf.seriesName!,
    ...(opf.seriesPosition !== null && { position: opf.seriesPosition }),
  };
}

/**
 * Fold the sidecar into an EXISTING provider match.
 *
 * The two constrained writes are the interesting ones:
 *
 * - **`authors`** is written only when the provider supplied none AND the folder supplied none.
 *   `buildBookCreatePayload` prefers `meta.authors` outright whenever it holds more than one author
 *   (deliberate, so co-authored provider results survive), so a two-creator OPF overlaid
 *   unconditionally would override the folder author. That rule is not modified here; the overlay is
 *   constrained around it.
 * - **`seriesPrimary`** is written only when the provider proposed no series at all. Item-first
 *   `resolveImportSeries` already protects the folder's series; this additionally keeps the OPF from
 *   overriding a provider series, which is what "corroborating, not overriding" means for a
 *   folder-carried field.
 */
function overlayOntoMatch(meta: BookMetadata, opf: OpfMetadata, item: ImportConfirmItem): BookMetadata {
  const next: BookMetadata = { ...meta };
  applyDescriptiveOverrides(next, opf);
  if (opf.asin !== null && !meta.asin) next.asin = opf.asin;
  if (opf.isbn !== null && !meta.isbn) next.isbn = opf.isbn;
  if (opf.seriesName !== null && !pickPrimarySeries(meta)) next.seriesPrimary = opfSeriesRef(opf);
  if (opf.authors.length && !meta.authors?.length && !hasAuthorName(item)) {
    next.authors = opf.authors.map((name) => ({ name }));
  }
  return next;
}

/** The five fields a folder name cannot carry — the OPF wins these outright. */
function applyDescriptiveOverrides(next: BookMetadata, opf: OpfMetadata): void {
  if (opf.subtitle !== null) next.subtitle = opf.subtitle;
  if (opf.description !== null) next.description = opf.description;
  if (opf.publisher !== null) next.publisher = opf.publisher;
  if (opf.publishedDate !== null) next.publishedDate = opf.publishedDate;
  if (opf.genres.length) next.genres = opf.genres;
}

/**
 * Build a synthetic `BookMetadata` when there was no provider match, so `buildBookCreatePayload`
 * still sees the sidecar's descriptive fields.
 *
 * `authors` follows the same table as {@link overlayOntoMatch}: the folder author when it exists, the
 * OPF's `aut` creators when it does not, and `[]` when neither does. `title` is the ITEM's — the
 * folder parse keeps its priority for the fields it carries.
 */
function synthesizeFromOpf(opf: OpfMetadata, item: ImportConfirmItem): BookMetadata {
  const authors = hasAuthorName(item)
    ? [{ name: item.authorName! }]
    : opf.authors.map((name) => ({ name }));
  return {
    title: item.title,
    authors,
    ...(opf.subtitle !== null && { subtitle: opf.subtitle }),
    ...(opf.description !== null && { description: opf.description }),
    ...(opf.publisher !== null && { publisher: opf.publisher }),
    ...(opf.publishedDate !== null && { publishedDate: opf.publishedDate }),
    ...(opf.genres.length > 0 && { genres: opf.genres }),
    ...(opf.narrators.length > 0 && { narrators: opf.narrators }),
    ...(opf.asin !== null && { asin: opf.asin }),
    ...(opf.isbn !== null && { isbn: opf.isbn }),
    ...(opf.seriesName !== null && { seriesPrimary: opfSeriesRef(opf) }),
  };
}

export interface OpfOverlayResult {
  /** The item every downstream consumer sees — unchanged when there was no usable sidecar. */
  item: ImportConfirmItem;
  narratorSource: NarratorSource;
}

/**
 * Apply the sidecar to a staged item.
 *
 * A `null` `opf` — absent, unreadable, oversized, malformed, or structurally valid but carrying no
 * usable field — returns the item **untouched** (`metadata: undefined` stays `undefined`, never an
 * empty object), so nothing about a bad OPF can change an item's disposition. The provenance
 * classification is still computed, because it is a statement about the wire payload and holds with
 * or without a sidecar.
 */
export function applyOpfOverlay(item: ImportConfirmItem, opf: OpfMetadata | null): OpfOverlayResult {
  const narratorSource = classifyNarratorSource(item, opf);
  if (!opf) return { item, narratorSource };

  const next: ImportConfirmItem = { ...item };
  if (opf.narrators.length) next.narrators = opf.narrators;
  next.metadata = item.metadata ? overlayOntoMatch(item.metadata, opf, item) : synthesizeFromOpf(opf, item);
  return { item: next, narratorSource };
}
