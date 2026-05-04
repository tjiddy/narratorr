import { formatDurationMinutes } from '@/lib/format';
import { bookStatusConfig } from '@/lib/status';
import type { BookWithAuthor } from '@/lib/api';
import { requireDefined } from '../../../shared/utils/assert.js';

export interface MetadataBook {
  subtitle?: string | undefined;
  description?: string | undefined;
  coverUrl?: string | undefined;
  duration?: number | undefined;
  genres?: string[] | undefined;
  narrators?: string[] | undefined;
  publisher?: string | undefined;
  series?: { name: string; position?: number | undefined }[] | undefined;
}

// eslint-disable-next-line complexity -- flat data coalescing across two sources, no nesting
export function mergeBookData(libraryBook: BookWithAuthor, metadataBook?: MetadataBook | null | undefined) {
  const description = libraryBook.description || metadataBook?.description;
  const coverUrl = libraryBook.coverUrl || metadataBook?.coverUrl;
  const genres = libraryBook.genres ?? metadataBook?.genres;
  const seriesName = libraryBook.seriesName || metadataBook?.series?.[0]?.name;
  const seriesPosition = libraryBook.seriesPosition ?? metadataBook?.series?.[0]?.position;
  const duration = formatDurationMinutes(libraryBook.duration ?? metadataBook?.duration);
  const publisher = metadataBook?.publisher;
  const status = requireDefined(
    bookStatusConfig[libraryBook.status] ?? bookStatusConfig.wanted,
    `mergeBookData: bookStatusConfig missing both "${libraryBook.status}" and fallback "wanted"`,
  );
  const narratorNames = (libraryBook.narrators.length > 0 ? libraryBook.narrators.map((n) => n.name).join(', ') : null) || metadataBook?.narrators?.join(', ');

  const metaDots: string[] = [];
  if (seriesName) {
    metaDots.push(`${seriesName}${seriesPosition != null ? ` #${seriesPosition}` : ''}`);
  }
  if (duration) metaDots.push(duration);
  if (publisher) metaDots.push(publisher);

  return {
    description,
    coverUrl,
    genres,
    narratorNames,
    metaDots,
    statusLabel: status.label,
    statusDotClass: status.dotClass,
    statusBarClass: status.barClass,
    subtitle: metadataBook?.subtitle,
    authorName: libraryBook.authors[0]?.name,
    authorAsin: libraryBook.authors[0]?.asin,
  };
}
