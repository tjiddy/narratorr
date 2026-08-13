import type { BookMetadata } from '@core/metadata/index.js';
import { pickPrimarySeries } from '@shared/pick-primary-series.js';
import type { OpfMetadata } from '../utils/opf-reader.js';
import type { ImportConfirmItem } from './library-scan.service.js';
import type { NarratorSource } from './import-adapters/types.js';

/**
 * Restore curated OPF data during re-import. OPF wins descriptive fields, narrators and series;
 * folder data keeps title/author priority, and OPF identifiers remain last-resort fallbacks.
 */

function hasAuthorName(item: ImportConfirmItem): boolean {
  return !!item.authorName?.trim();
}

/** Exact trimmed, ordered equality identifies an untouched provider proposal. */
function sameNarrators(own: string[], provider: string[]): boolean {
  return own.length === provider.length && own.every((name, i) => name.trim() === provider[i]!.trim());
}

/**
 * OPF narration wins before wire provenance. An empty wire field is indistinguishable from absent
 * and remains refillable; durable clears require tombstones, which OPF does not carry.
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
 * A non-null OPF series outranks the provider's, like its five descriptive siblings: the sidecar is
 * deliberately written and lossless, while the folder path it was once deferred to is rendered FROM
 * the DB and cannot round-trip a colon (#2296). OPF authors and identifiers stay fill-the-gap.
 */
function overlayOntoMatch(meta: BookMetadata, opf: OpfMetadata, item: ImportConfirmItem): BookMetadata {
  const next: BookMetadata = { ...meta };
  applyDescriptiveOverrides(next, opf);
  if (opf.asin !== null && !meta.asin) next.asin = opf.asin;
  if (opf.isbn !== null && !meta.isbn) next.isbn = opf.isbn;
  if (opf.seriesName !== null) next.seriesPrimary = opfSeriesRef(opf);
  if (opf.authors.length && !meta.authors?.length && !hasAuthorName(item)) {
    next.authors = opf.authors.map((name) => ({ name }));
  }
  return next;
}

/**
 * The client seeds an untouched row's series from the match, so a top-level name equal to the
 * provider's primary is that mirror rather than curation — and it outranks `metadata.seriesPrimary`
 * at `resolveImportSeries`, so a metadata-only overlay would never reach the row. Identity is the
 * NAME alone: `buildEditedFromBestMatch` keeps the FOLDER's position when the primary carries none,
 * so requiring the pair to match would misread that hybrid as curation.
 */
function mirrorsProviderSeries(item: ImportConfirmItem, providerPrimary: { name?: string } | undefined): boolean {
  const own = item.seriesName?.trim();
  const provider = providerPrimary?.name?.trim();
  return !!own && !!provider && own === provider;
}

/** Name and position replace the mirrored pair as a unit; an absent index deletes the stale one. */
function applyOpfSeriesToItem(next: ImportConfirmItem, opf: OpfMetadata): void {
  next.seriesName = opf.seriesName!;
  if (opf.seriesPosition === null) delete next.seriesPosition;
  else next.seriesPosition = opf.seriesPosition;
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
 * Synthesize metadata without a provider match while preserving folder title and author priority.
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
  item: ImportConfirmItem;
  narratorSource: NarratorSource;
}

/**
 * A missing or unusable OPF returns the exact item untouched, while narrator provenance still
 * reflects the wire payload.
 */
export function applyOpfOverlay(item: ImportConfirmItem, opf: OpfMetadata | null): OpfOverlayResult {
  const narratorSource = classifyNarratorSource(item, opf);
  if (!opf) return { item, narratorSource };

  // Classify before overlayOntoMatch writes the OPF series into seriesPrimary; comparing against the
  // post-overlay value makes every item read as non-mirrored and silently no-ops the item-level fix.
  const mirrored = opf.seriesName !== null && mirrorsProviderSeries(item, pickPrimarySeries(item.metadata));

  const next: ImportConfirmItem = { ...item };
  if (opf.narrators.length) next.narrators = opf.narrators;
  next.metadata = item.metadata ? overlayOntoMatch(item.metadata, opf, item) : synthesizeFromOpf(opf, item);
  if (mirrored) applyOpfSeriesToItem(next, opf);
  return { item: next, narratorSource };
}
