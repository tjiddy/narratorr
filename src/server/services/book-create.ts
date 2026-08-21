import { type books } from '@db/schema.js';
import { generatePublicId } from '../utils/public-id.js';
import { productionTypeSchema, type ProductionType } from '@shared/schemas/book.js';
import { usefulString } from './metadata-recording-collapse.js';
import { inferGenresFromTitleMarkers, mergeInferredGenres } from '@core/metadata/genres.js';
import type { BookRow } from './types.js';

/** Public create payload; providerId is consumed before the insert primitive. */
export interface CreateBookInput {
  title: string;
  authors: { name: string; asin?: string | undefined }[];
  narrators?: string[] | undefined;
  subtitle?: string | undefined;
  description?: string | undefined;
  publisher?: string | undefined;
  coverUrl?: string | undefined;
  asin?: string | undefined;
  isbn?: string | undefined;
  seriesName?: string | undefined;
  seriesPosition?: number | undefined;
  duration?: number | undefined;
  publishedDate?: string | undefined;
  genres?: string[] | undefined;
  status?: BookRow['status'] | undefined;
  enrichmentStatus?: BookRow['enrichmentStatus'] | undefined;
  productionType?: ProductionType | undefined;
  providerId?: string | undefined;
  importListId?: number | undefined;
}

export type ResolvedBookCreateInput = Omit<CreateBookInput, 'providerId'>;

/** Build the insert payload and validate the SQLite-unchecked production type at the boundary. */
export function buildNewBookValues(
  data: ResolvedBookCreateInput,
  canonicalAsin: string | null,
): typeof books.$inferInsert {
  // Computed as a pair so a blank provider name can never leave an orphan position behind (#2224).
  const seriesPair = usefulString(data.seriesName)
    ? { seriesName: data.seriesName, seriesPosition: data.seriesPosition }
    : {};

  // The single create choke point, so every add path — POST /api/books, import-list sync, series
  // add-all, import commit — picks the marker up here (#2535). An unmarked create is unchanged,
  // undefined included: `recomputeClearedFields` reads an empty array as an operator clear.
  const inferred = mergeInferredGenres(
    data.genres,
    inferGenresFromTitleMarkers(data.title, data.subtitle, data.seriesName),
  );

  return {
    publicId: generatePublicId('bk'),
    title: data.title,
    subtitle: data.subtitle,
    description: data.description,
    publisher: data.publisher,
    coverUrl: data.coverUrl,
    asin: canonicalAsin,
    isbn: data.isbn,
    ...seriesPair,
    duration: data.duration,
    publishedDate: data.publishedDate,
    genres: inferred.changed ? inferred.genres : data.genres,
    status: data.status || 'wanted',
    enrichmentStatus: data.enrichmentStatus,
    productionType: productionTypeSchema.parse(data.productionType ?? 'unknown'),
    importListId: data.importListId,
  };
}
