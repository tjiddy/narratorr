import { eq } from 'drizzle-orm';
import type { DbOrTx } from '@db/index.js';
import { series } from '@db/schema.js';
import type { SeriesRow } from './types.js';
import type { HardcoverSeriesData } from '@core/metadata/hardcover.js';
import { generatePublicId } from '../utils/public-id.js';

/** Upsert by Hardcover id first, then normalized name, so renames cannot collide. */
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
