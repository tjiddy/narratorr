import { eq } from 'drizzle-orm';
import type { DbOrTx } from '../../db/index.js';
import { books } from '../../db/schema.js';
import { normalizeSeriesName } from '../utils/series-normalize.js';
import type { BookMetadata } from '../../core/metadata/index.js';
import type { CandidateInfo } from './series-refresh.dedupe.js';
import { normalizeSeriesMemberWorkTitle } from './series-refresh.dedupe.js';

/** Format-type tie-breaker keys (case-insensitive). Lower = preferred. (#1088 F3) */
const RADIO_FORMAT_TYPES = new Set(['radio', 'original_recording']);

function formatTypeOf(product: BookMetadata): string | null {
  return product.formatType ? product.formatType.toLowerCase() : null;
}

function contentDeliveryTypeOf(product: BookMetadata): string | null {
  return product.contentDeliveryType ? product.contentDeliveryType.toLowerCase() : null;
}

function metadataRichness(product: BookMetadata): number {
  let score = 0;
  if (product.coverUrl) score += 1;
  if (product.duration != null) score += 1;
  if (product.publishedDate) score += 1;
  if (product.publisher) score += 1;
  return score;
}

/**
 * Score where lower wins. `unabridged` beats `abridged`; absent or any other
 * value sits between them so it never causes a hard drop. (#1088 F3)
 */
function formatTypePreference(product: BookMetadata): number {
  const ft = formatTypeOf(product);
  if (ft === 'unabridged') return 0;
  if (ft === 'abridged') return 2;
  return 1;
}

function contentDeliveryPreference(product: BookMetadata): number {
  const cdt = contentDeliveryTypeOf(product);
  if (cdt === 'singlepartbook') return 0;
  if (cdt === 'multipartbook') return 2;
  return 1;
}

/**
 * 0 when the product's title carries no edition/split/adaptation suffix — i.e.
 * `normalizeSeriesMemberWorkTitle(title) === normalizeSeriesName(title)`. 1 when
 * a suffix was stripped. Drives tier-1 of `pickCanonical`: the visible Series
 * card row must show a clean work title, not a dramatized-split product. (#1116)
 */
function cleanTitleScore(c: CandidateInfo): number {
  return normalizeSeriesMemberWorkTitle(c.product.title) === normalizeSeriesName(c.product.title) ? 0 : 1;
}

/** 1 when the title mentions a dramatized adaptation, 0 otherwise. (#1116) */
function dramatizedScore(c: CandidateInfo): number {
  return /dramatized/i.test(c.product.title) ? 1 : 0;
}

/**
 * Multi-tier ranking key for `pickCanonical`. Lower wins on each tier in turn.
 * Local-library and seed presence are demoted below clean-title and edition
 * preferences so a locally-owned dramatized split never overrides the clean
 * canonical for display; reachability instead resolves via `alternate_asins`
 * traversal in `linkLocalBooksByAsin` / `isMemberCurrent`. (#1116 F2)
 */
function canonicalScore(c: CandidateInfo, seedAsin: string, localLibraryAsins: Set<string>): number[] {
  const asin = c.product.asin ?? null;
  return [
    cleanTitleScore(c),
    dramatizedScore(c),
    formatTypePreference(c.product),
    contentDeliveryPreference(c.product),
    asin === seedAsin ? 0 : 1,
    asin !== null && localLibraryAsins.has(asin) ? 0 : 1,
    -metadataRichness(c.product),
  ];
}

export async function pickCanonical(
  db: DbOrTx,
  group: CandidateInfo[],
  seedAsin: string,
): Promise<CandidateInfo> {
  const localLibraryAsins = new Set<string>();
  for (const c of group) {
    if (!c.product.asin) continue;
    const rows = await db.select({ id: books.id }).from(books).where(eq(books.asin, c.product.asin)).limit(1);
    if (rows.length > 0) localLibraryAsins.add(c.product.asin);
  }
  return [...group].sort((a, b) => {
    const aScore = canonicalScore(a, seedAsin, localLibraryAsins);
    const bScore = canonicalScore(b, seedAsin, localLibraryAsins);
    for (let i = 0; i < aScore.length; i++) {
      const diff = aScore[i]! - bScore[i]!;
      if (diff !== 0) return diff;
    }
    const aAsin = a.product.asin ?? '￿';
    const bAsin = b.product.asin ?? '￿';
    return aAsin.localeCompare(bAsin);
  })[0]!;
}

/**
 * Drop candidates whose `formatType` is `radio` or `original_recording` —
 * Audible commonly returns radio-play editions alongside the audiobook series
 * (Hitchhiker's, Doctor Who). Exception: when the seed book itself carries the
 * same format, the user intentionally seeded with a radio-play ASIN, so the
 * exception keeps that series buildable. Case-insensitive; absent `formatType`
 * is never dropped. (#1088 F3)
 */
export function filterRadioFormatType(products: BookMetadata[], seedAsin: string): BookMetadata[] {
  const seed = products.find((p) => p.asin === seedAsin);
  const seedFormat = seed ? formatTypeOf(seed) : null;
  return products.filter((p) => {
    const ft = formatTypeOf(p);
    if (ft === null) return true;
    if (!RADIO_FORMAT_TYPES.has(ft)) return true;
    return seedFormat === ft;
  });
}
