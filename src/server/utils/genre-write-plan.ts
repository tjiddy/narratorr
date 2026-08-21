import { inferGenresFromTitleMarkers, mergeInferredGenres } from '@core/metadata/genres.js';

/**
 * The text a litRPG-family marker can hide in, at its EFFECTIVE value — a field the same pass is
 * about to fill wins over the pre-update column, and a fill the pass declined does not count.
 */
export interface GenreMarkerFields {
  title?: string | null | undefined;
  subtitle?: string | null | undefined;
  seriesName?: string | null | undefined;
}

export interface GenreWritePlan {
  /** The single value to write, or null when neither rule produced one. */
  genres: string[] | null;
  /** True only when a provider fill-empty landed — the sole thing `filledGenres` counts. */
  providerFilled: boolean;
}

const NO_GENRE_WRITE: GenreWritePlan = { genres: null, providerFilled: false };

/**
 * Resolve the one genres value an enrichment pass writes, shared by the post-import and scheduled
 * paths so they cannot drift.
 *
 * The provider rule stays fill-empty. The marker inference (#2535) is additive on top of whatever
 * the row will end up holding, because the books that carry a marker are exactly the ones the
 * fill-empty rule refuses — they already have genres. Callers must apply the `genres` tombstone
 * themselves; this is pure and knows nothing about it.
 */
export function resolveGenreWrite(
  providerGenres: string[] | null | undefined,
  liveGenres: readonly string[] | null | undefined,
  markers: GenreMarkerFields,
): GenreWritePlan {
  const fillEmpty = !!providerGenres?.length && !liveGenres?.length;
  const providerFill = fillEmpty ? providerGenres! : null;

  const merged = mergeInferredGenres(
    providerFill ?? liveGenres,
    inferGenresFromTitleMarkers(markers.title, markers.subtitle, markers.seriesName),
  );
  if (merged.changed && merged.genres) return { genres: merged.genres, providerFilled: fillEmpty };

  return providerFill ? { genres: providerFill, providerFilled: true } : NO_GENRE_WRITE;
}
