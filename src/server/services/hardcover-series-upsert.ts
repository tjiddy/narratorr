import { eq } from 'drizzle-orm';
import type { DbOrTx } from '@db/index.js';
import { series } from '@db/schema.js';
import type { SeriesRow } from './types.js';
import type { HardcoverSeriesData } from '@core/metadata/hardcover.js';
import { generatePublicId } from '../utils/public-id.js';

/**
 * Id-first upsert of the canonical `series` row for a resolved Hardcover series.
 * Extracted from `series-card.service.ts` (which is at its `max-lines` cap); the
 * body is unchanged. Matches on `hardcover_series_id` first so a renamed series
 * cannot collide on the normalized-name unique index, then falls back to the
 * normalized name, then inserts.
 */
export async function upsertHardcoverSeries(
  tx: DbOrTx,
  resolved: HardcoverSeriesData,
  normalized: string,
): Promise<SeriesRow> {
  const byHardcoverId = await tx
    .select()
    .from(series)
    .where(eq(series.hardcoverSeriesId, resolved.id))
    .limit(1);
  if (byHardcoverId.length > 0) {
    const existing = byHardcoverId[0]!;
    const updated = await tx
      .update(series)
      .set({
        name: resolved.name,
        normalizedName: normalized,
        authorName: resolved.authorName,
        lastFetchedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(series.id, existing.id))
      .returning();
    return updated[0]!;
  }
  const byName = await tx
    .select()
    .from(series)
    .where(eq(series.normalizedName, normalized))
    .limit(1);
  if (byName.length > 0) {
    const existing = byName[0]!;
    const updated = await tx
      .update(series)
      .set({
        hardcoverSeriesId: resolved.id,
        name: resolved.name,
        authorName: resolved.authorName,
        lastFetchedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(series.id, existing.id))
      .returning();
    return updated[0]!;
  }
  const inserted = await tx
    .insert(series)
    .values({
      publicId: generatePublicId('sr'),
      hardcoverSeriesId: resolved.id,
      name: resolved.name,
      normalizedName: normalized,
      authorName: resolved.authorName,
      lastFetchedAt: new Date(),
    })
    .returning();
  return inserted[0]!;
}
