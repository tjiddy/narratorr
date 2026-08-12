import { type books } from '@db/schema.js';
import { canonicalizeAsin } from '@shared/asin.js';
import type { ReplaceSeriesLinkArgs } from './book-series-link.js';
import { usefulString } from './metadata-recording-collapse.js';

/** Full replacement payload: undefined optional fields are persisted as NULL. */
export interface FixMatchReplacement {
  asin?: string | undefined;
  title: string;
  subtitle?: string | undefined;
  authors: { name: string; asin?: string | undefined }[];
  narrators?: string[] | undefined;
  description?: string | undefined;
  publisher?: string | undefined;
  coverUrl?: string | undefined;
  duration?: number | undefined;
  publishedDate?: string | undefined;
  seriesName?: string | undefined;
  seriesPosition?: number | undefined;
  genres?: string[] | undefined;
  isbn?: string | undefined;
}

export function buildFixMatchScalarUpdates(r: FixMatchReplacement): Partial<typeof books.$inferInsert> {
  // Fix Match replaces identity wholesale, so an unusable name clears the pair rather than omitting it (#2224).
  const seriesPair = usefulString(r.seriesName)
    ? { seriesName: r.seriesName ?? null, seriesPosition: r.seriesPosition ?? null }
    : { seriesName: null, seriesPosition: null };

  return {
    title: r.title,
    subtitle: r.subtitle ?? null,
    description: r.description ?? null,
    publisher: r.publisher ?? null,
    coverUrl: r.coverUrl ?? null,
    asin: canonicalizeAsin(r.asin),
    isbn: r.isbn ?? null,
    ...seriesPair,
    duration: r.duration ?? null,
    publishedDate: r.publishedDate ?? null,
    genres: r.genres ?? null,
    // Re-identification resets tombstones belonging to the prior bibliographic identity.
    userClearedFields: null,
    enrichmentStatus: 'pending',
    enrichmentAttempts: 0,
    updatedAt: new Date(),
  };
}

export function buildReplaceSeriesLinkArgs(r: FixMatchReplacement): ReplaceSeriesLinkArgs | null {
  // Null detaches any prior link, so an unusable name clears the series instead of seeding a blank one (#2224).
  // usefulString is a plain boolean, so the presence arm carries the narrowing.
  if (r.seriesName === undefined || !usefulString(r.seriesName)) return null;
  return {
    name: r.seriesName,
    position: r.seriesPosition ?? null,
    title: r.title,
    authorName: r.authors[0]?.name ?? null,
  };
}
