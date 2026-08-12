import { formatDurationMinutes, formatYear } from '@/lib/format';
import { bookStatusConfig } from '@/lib/status';
import type { BookWithAuthor } from '@/lib/api';
import { requireDefined } from '@shared/utils/assert.js';
import { pickPrimarySeries } from '@shared/pick-primary-series.js';

export interface MetadataBook {
  subtitle?: string | undefined;
  description?: string | undefined;
  coverUrl?: string | undefined;
  duration?: number | undefined;
  genres?: string[] | undefined;
  narrators?: string[] | undefined;
  publisher?: string | undefined;
  publishedDate?: string | undefined;
  series?: { name: string; position?: number | undefined }[] | undefined;
  seriesPrimary?: { name: string; position?: number | undefined } | undefined;
}

/** `undefined` means the field is tombstoned or neither source provides a value. */
export interface DisplayedFields {
  seriesName: string | undefined;
  seriesPosition: number | undefined;
  subtitle: string | undefined;
  description: string | undefined;
  publisher: string | undefined;
  publishedDate: string | undefined;
  genres: string[] | undefined;
}

/**
 * Shared display/edit resolution for clearable fields. Tombstones suppress both
 * sources. String fields use `||`, while genres and position use `??`, preserving
 * the intentional `''` fallback and `[]` override. Position also requires a name.
 */
export function resolveDisplayedFields(
  libraryBook: BookWithAuthor,
  metadataBook?: MetadataBook | null | undefined,
): DisplayedFields {
  const cleared = new Set<string>(libraryBook.userClearedFields ?? []);
  const primaryMetaSeries = pickPrimarySeries(metadataBook);
  const seriesName = orProvider(cleared, 'seriesName', libraryBook.seriesName, primaryMetaSeries?.name);

  return {
    seriesName,
    // Position needs a resolved name and has its own tombstone.
    seriesPosition: seriesName && !cleared.has('seriesPosition')
      ? (libraryBook.seriesPosition ?? primaryMetaSeries?.position)
      : undefined,
    subtitle: orProvider(cleared, 'subtitle', libraryBook.subtitle, metadataBook?.subtitle),
    description: orProvider(cleared, 'description', libraryBook.description, metadataBook?.description),
    publisher: orProvider(cleared, 'publisher', libraryBook.publisher, metadataBook?.publisher),
    publishedDate: orProvider(cleared, 'publishedDate', libraryBook.publishedDate, metadataBook?.publishedDate),
    // A stored [] deliberately overrides the provider list.
    genres: cleared.has('genres') ? undefined : (libraryBook.genres ?? metadataBook?.genres),
  };
}

function orProvider(
  cleared: ReadonlySet<string>,
  field: string,
  stored: string | null | undefined,
  provider: string | undefined,
): string | undefined {
  if (cleared.has(field)) return undefined;
  return stored || provider;
}

export function mergeBookData(libraryBook: BookWithAuthor, metadataBook?: MetadataBook | null | undefined) {
  const displayed = resolveDisplayedFields(libraryBook, metadataBook);
  const coverUrl = libraryBook.coverUrl || metadataBook?.coverUrl;
  const duration = formatDurationMinutes(libraryBook.duration ?? metadataBook?.duration);
  const year = formatYear(displayed.publishedDate);
  const status = requireDefined(
    bookStatusConfig[libraryBook.status],
    `mergeBookData: bookStatusConfig missing entry for "${libraryBook.status}"`,
  );
  const narratorNames = (libraryBook.narrators.length > 0 ? libraryBook.narrators.map((n) => n.name).join(', ') : null) || metadataBook?.narrators?.join(', ');

  const metaDots: string[] = [];
  if (displayed.seriesName) {
    metaDots.push(`${displayed.seriesName}${displayed.seriesPosition != null ? ` #${displayed.seriesPosition}` : ''}`);
  }
  if (duration) metaDots.push(duration);
  if (year) metaDots.push(year);
  if (displayed.publisher) metaDots.push(displayed.publisher);

  return {
    description: displayed.description,
    coverUrl,
    genres: displayed.genres,
    narratorNames,
    metaDots,
    statusLabel: status.label,
    statusDotClass: status.dotClass,
    statusBarClass: status.barClass,
    subtitle: displayed.subtitle,
    authors: libraryBook.authors.map((a) => ({ name: a.name, asin: a.asin })),
  };
}
