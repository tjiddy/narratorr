import { BookMetadataSchema, AuthorMetadataSchema, SeriesMetadataSchema } from './schemas.js';
import { normalizeGenres } from './genres.js';
import { RateLimitError } from './errors.js';
import type {
  MetadataProvider,
  BookMetadata,
  AuthorMetadata,
  SeriesMetadata,
  MetadataSearchResults,
} from './types.js';

export interface HardcoverConfig {
  apiKey: string;
}

const API_URL = 'https://api.hardcover.app/v1/graphql';
const REQUEST_TIMEOUT_MS = 20000;

// ---------------------------------------------------------------------------
// GraphQL queries
// ---------------------------------------------------------------------------

const SEARCH_QUERY = `
query Search($q: String!, $type: String!, $perPage: Int) {
  search(query: $q, query_type: $type, per_page: $perPage) {
    results
  }
}`;

const GET_BOOK_QUERY = `
query GetBook($id: Int!) {
  books(where: { id: { _eq: $id } }, limit: 1) {
    id
    title
    subtitle
    slug
    description
    release_date
    release_year
    pages
    audio_seconds
    rating
    cached_image
    cached_tags
    cached_contributors
    contributions {
      contribution
      author {
        id
        name
        slug
        cached_image
      }
    }
    featured_book_series {
      position
      series {
        id
        name
        slug
      }
    }
    default_audio_edition {
      id
      asin
      isbn_13
      audio_seconds
      publisher { name }
      release_date
    }
    editions(
      where: { reading_format_id: { _eq: 2 } }
      order_by: { users_count: desc }
      limit: 5
    ) {
      id
      asin
      isbn_13
      audio_seconds
      publisher { name }
      release_date
    }
  }
}`;

const GET_AUTHOR_QUERY = `
query GetAuthor($id: Int!) {
  authors(where: { id: { _eq: $id } }, limit: 1) {
    id
    name
    slug
    bio
    books_count
    cached_image
    contributions(
      where: { contributable_type: { _eq: "Book" } }
      order_by: { book: { users_count: desc } }
      limit: 50
    ) {
      contribution
      book {
        id
        title
        slug
        release_year
        audio_seconds
        rating
        cached_image
        featured_book_series {
          position
          series {
            id
            name
            slug
          }
        }
      }
    }
  }
}`;

const GET_SERIES_QUERY = `
query GetSeries($id: Int!) {
  series(where: { id: { _eq: $id } }, limit: 1) {
    id
    name
    slug
    description
    books_count
    primary_books_count
    author {
      id
      name
      slug
    }
    book_series(
      where: { book: { compilation: { _eq: false } } }
      order_by: { position: asc }
    ) {
      position
      book {
        id
        title
        slug
        release_year
        audio_seconds
        rating
        cached_image
        cached_contributors
      }
    }
  }
}`;

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

export class HardcoverProvider implements MetadataProvider {
  readonly name = 'Hardcover';
  readonly type = 'hardcover';

  private apiKey: string;

  constructor(config: HardcoverConfig) {
    this.apiKey = config.apiKey;
  }

  async search(query: string): Promise<MetadataSearchResults> {
    const [books, authors, series] = await Promise.all([
      this.searchBooks(query).catch(() => [] as BookMetadata[]),
      this.searchAuthors(query).catch(() => [] as AuthorMetadata[]),
      this.searchSeries(query).catch(() => [] as SeriesMetadata[]),
    ]);
    return { books, authors, series };
  }

  async searchBooks(query: string): Promise<BookMetadata[]> {
    const data = await this.gql<SearchResponse>(SEARCH_QUERY, {
      q: query,
      type: 'Book',
      perPage: 15,
    });
    const hits = extractHits(data?.search?.results);

    const books: BookMetadata[] = [];
    for (const hit of hits) {
      const doc = hit.document;
      if (!doc) continue;
      const mapped = mapSearchBook(doc, hit.text_match);
      const result = BookMetadataSchema.safeParse(mapped);
      if (result.success) books.push(result.data);
    }
    return sortBooksByRelevance(books);
  }

  async searchAuthors(query: string): Promise<AuthorMetadata[]> {
    const data = await this.gql<SearchResponse>(SEARCH_QUERY, {
      q: query,
      type: 'Author',
      perPage: 15,
    });
    const hits = extractHits(data?.search?.results);

    const authors: AuthorMetadata[] = [];
    for (const hit of hits) {
      const doc = hit.document;
      if (!doc) continue;
      const mapped = mapSearchAuthor(doc, hit.text_match);
      const result = AuthorMetadataSchema.safeParse(mapped);
      if (result.success) authors.push(result.data);
    }
    return authors;
  }

  async searchSeries(query: string): Promise<SeriesMetadata[]> {
    const data = await this.gql<SearchResponse>(SEARCH_QUERY, {
      q: query,
      type: 'Series',
      perPage: 15,
    });
    const hits = extractHits(data?.search?.results);

    const seriesList: SeriesMetadata[] = [];
    for (const hit of hits) {
      const doc = hit.document;
      if (!doc) continue;
      const mapped = mapSearchSeries(doc);
      const result = SeriesMetadataSchema.safeParse(mapped);
      if (result.success) seriesList.push(result.data);
    }
    return seriesList;
  }

  async getBook(id: string): Promise<BookMetadata | null> {
    const data = await this.gql<{ books: HardcoverBookDetail[] }>(GET_BOOK_QUERY, {
      id: parseInt(id, 10),
    });
    const book = data?.books?.[0];
    if (!book) return null;

    const mapped = mapBookDetail(book);
    const result = BookMetadataSchema.safeParse(mapped);
    return result.success ? result.data : null;
  }

  async getAuthor(id: string): Promise<AuthorMetadata | null> {
    const data = await this.gql<{ authors: HardcoverAuthorDetail[] }>(GET_AUTHOR_QUERY, {
      id: parseInt(id, 10),
    });
    const author = data?.authors?.[0];
    if (!author) return null;

    const mapped = mapAuthorDetail(author);
    const result = AuthorMetadataSchema.safeParse(mapped);
    return result.success ? result.data : null;
  }

  async getAuthorBooks(id: string): Promise<BookMetadata[]> {
    const data = await this.gql<{ authors: HardcoverAuthorDetail[] }>(GET_AUTHOR_QUERY, {
      id: parseInt(id, 10),
    });
    const author = data?.authors?.[0];
    if (!author?.contributions) return [];

    const books: BookMetadata[] = [];
    for (const c of author.contributions) {
      if (!c.book) continue;
      const mapped = mapContributionBook(c.book);
      const result = BookMetadataSchema.safeParse(mapped);
      if (result.success) books.push(result.data);
    }
    return books;
  }

  async getSeries(id: string): Promise<SeriesMetadata | null> {
    const data = await this.gql<{ series: HardcoverSeriesDetail[] }>(GET_SERIES_QUERY, {
      id: parseInt(id, 10),
    });
    const series = data?.series?.[0];
    if (!series) return null;

    const mapped = mapSeriesDetail(series);
    const result = SeriesMetadataSchema.safeParse(mapped);
    return result.success ? result.data : null;
  }

  async test(): Promise<{ success: boolean; message?: string }> {
    try {
      const data = await this.gql<SearchResponse>(SEARCH_QUERY, { q: 'test', type: 'Book', perPage: 1 });
      if (data?.search?.results) {
        return { success: true, message: 'Connected to Hardcover API' };
      }
      return { success: false, message: 'Unexpected response from Hardcover API' };
    } catch (error) {
      return {
        success: false,
        message: error instanceof Error ? error.message : 'Connection failed',
      };
    }
  }

  private async gql<T>(query: string, variables?: Record<string, unknown>): Promise<T | null> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    try {
      const res = await fetch(API_URL, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({ query, variables }),
        signal: controller.signal,
      });
      if (res.status === 429) {
        const retryAfter = res.headers.get('Retry-After');
        const waitMs = retryAfter ? parseInt(retryAfter, 10) * 1000 : 60_000;
        throw new RateLimitError(waitMs, 'Hardcover');
      }
      if (!res.ok) return null;
      const json = (await res.json()) as { data?: T; errors?: Array<{ message: string }> };
      if (json.errors?.length) return null;
      return (json.data as T) ?? null;
    } catch (error) {
      if (error instanceof RateLimitError) throw error;
      return null;
    } finally {
      clearTimeout(timeoutId);
    }
  }
}

// ---------------------------------------------------------------------------
// Internal response shapes
// ---------------------------------------------------------------------------

interface SearchHit {
  document: Record<string, unknown>;
  text_match?: number;
}

interface SearchResults {
  hits: SearchHit[];
  found: number;
}

interface SearchResponse {
  search: {
    results: SearchResults;
  };
}

interface HardcoverImage {
  url: string;
  id?: number;
  color?: string;
  width?: number;
  height?: number;
  color_name?: string;
}

interface HardcoverTagEntry {
  tag: string;
  tagSlug?: string;
  category?: string;
  categorySlug?: string;
  spoilerRatio?: number | null;
  count?: number;
}

interface HardcoverContributorEntry {
  author: { id: number; name: string; slug?: string; image?: HardcoverImage | null };
  contribution: string | null;
}

interface HardcoverBookDetail {
  id: number;
  title?: string;
  subtitle?: string;
  slug?: string;
  description?: string;
  release_date?: string;
  release_year?: number;
  pages?: number;
  audio_seconds?: number | null;
  rating?: number;
  cached_image?: HardcoverImage | null;
  cached_tags?: Record<string, HardcoverTagEntry[]>;
  cached_contributors?: HardcoverContributorEntry[];
  contributions?: Array<{
    contribution: string | null;
    author: { id: number; name: string; slug: string; cached_image?: HardcoverImage | null };
  }>;
  featured_book_series?: {
    position: number;
    series: { id: number; name: string; slug: string };
  } | null;
  default_audio_edition?: {
    id: number;
    asin?: string | null;
    isbn_13?: string | null;
    audio_seconds?: number | null;
    publisher?: { name: string };
    release_date?: string;
  } | null;
  editions?: Array<{
    id: number;
    asin?: string | null;
    isbn_13?: string | null;
    audio_seconds?: number | null;
    publisher?: { name: string } | null;
    release_date?: string;
  }>;
}

interface HardcoverAuthorDetail {
  id: number;
  name: string;
  slug?: string;
  bio?: string;
  books_count?: number;
  cached_image?: HardcoverImage | null;
  contributions?: Array<{
    contribution: string | null;
    book?: {
      id: number;
      title: string;
      slug?: string;
      release_year?: number;
      audio_seconds?: number | null;
      rating?: number;
      cached_image?: HardcoverImage | null;
      featured_book_series?: {
        position: number;
        series: { id: number; name: string; slug: string };
      } | null;
    };
  }>;
}

interface HardcoverSeriesDetail {
  id: number;
  name: string;
  slug?: string;
  description?: string | null;
  books_count?: number;
  primary_books_count?: number;
  author?: { id: number; name: string; slug: string };
  book_series?: Array<{
    position: number;
    book: {
      id: number;
      title: string;
      slug?: string;
      release_year?: number | null;
      audio_seconds?: number | null;
      rating?: number;
      cached_image?: HardcoverImage | null;
      cached_contributors?: HardcoverContributorEntry[];
    };
  }>;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Extract hits array from search results (object with `hits` key). */
function extractHits(results: unknown): SearchHit[] {
  if (!results || typeof results !== 'object') return [];
  if ('hits' in results && Array.isArray((results as SearchResults).hits)) {
    return (results as SearchResults).hits;
  }
  return [];
}

function extractImageUrl(image: unknown): string | undefined {
  if (!image) return undefined;
  if (typeof image === 'string') return image || undefined;
  if (typeof image === 'object' && image !== null && 'url' in image) {
    return (image as { url: string }).url || undefined;
  }
  return undefined;
}

/** Extract genre names from cached_tags, sorted by popularity count, then normalized. */
function extractGenres(cachedTags: Record<string, HardcoverTagEntry[]> | undefined): string[] | undefined {
  const genreEntries = cachedTags?.['Genre'];
  if (!genreEntries?.length) return undefined;
  const sorted = [...genreEntries].sort((a, b) => (b.count ?? 0) - (a.count ?? 0));
  const raw = sorted.map((entry) => entry.tag).filter(Boolean);
  return normalizeGenres(raw);
}

// ---------------------------------------------------------------------------
// Sorting
// ---------------------------------------------------------------------------

function sortBooksByRelevance(books: BookMetadata[]): BookMetadata[] {
  return books.sort((a, b) => {
    const scoreA = bookRelevanceScore(a);
    const scoreB = bookRelevanceScore(b);
    return scoreB - scoreA;
  });
}

function bookRelevanceScore(book: BookMetadata): number {
  let score = book.relevance ?? 0;
  // Boost books that have a series position (canonical editions, not compilations)
  if (book.series?.some((s) => s.position != null)) score += 0.5;
  // Boost books with audio duration (audiobook exists)
  if (book.duration) score += 0.3;
  // Boost books with cover art (better metadata quality)
  if (book.coverUrl) score += 0.2;
  return score;
}

// ---------------------------------------------------------------------------
// Mapping helpers
// ---------------------------------------------------------------------------

function mapSearchBook(doc: Record<string, unknown>, textMatch?: number): Record<string, unknown> {
  const isbns = doc.isbns as string[] | undefined;
  const genres = normalizeGenres(doc.genres as string[] | undefined);
  const authorNames = doc.author_names as string[] | undefined;
  const contributions = doc.contributions as Array<{ author: { name: string; id: number } }> | undefined;
  const featuredSeries = doc.featured_series as { position: number; series: { name: string; id: number } } | null | undefined;
  const audioSeconds = doc.audio_seconds as number | null | undefined;

  const authors = contributions?.map((c) => ({ name: c.author.name }))
    ?? authorNames?.map((name) => ({ name }))
    ?? [];

  const series = featuredSeries?.series
    ? [{ name: featuredSeries.series.name, position: featuredSeries.position }]
    : undefined;

  return {
    title: (doc.title as string) ?? '',
    subtitle: (doc.subtitle as string) || undefined,
    authors,
    series,
    description: (doc.description as string) || undefined,
    publishedDate: doc.release_year ? String(doc.release_year) : undefined,
    coverUrl: extractImageUrl(doc.image),
    duration: audioSeconds ? Math.round(audioSeconds / 60) : undefined,
    genres,
    isbn: isbns?.[0],
    providerId: doc.id ? String(doc.id) : undefined,
    relevance: textMatch,
  };
}

function mapSearchAuthor(doc: Record<string, unknown>, textMatch?: number): Record<string, unknown> {
  return {
    name: (doc.name as string) ?? '',
    imageUrl: extractImageUrl(doc.image),
    relevance: textMatch,
  };
}

function mapSearchSeries(doc: Record<string, unknown>): Record<string, unknown> {
  return {
    name: (doc.name as string) ?? '',
    books: [],
  };
}

function mapBookDetail(book: HardcoverBookDetail): Record<string, unknown> {
  // Use contributions for author names; treat null contribution as author, exclude narrators
  const authors = (book.contributions ?? [])
    .filter((c) => c.contribution?.toLowerCase() !== 'narrator')
    .map((c) => ({ name: c.author.name }));

  // Extract narrators from contributions or cached_contributors
  // The contribution field is "Narrator" for narrators, null for authors
  const allContributors = [
    ...(book.contributions ?? []),
    ...(book.cached_contributors ?? []),
  ];
  const narrators = [...new Set(
    allContributors
      .filter((c) => c.contribution?.toLowerCase() === 'narrator')
      .map((c) => c.author.name),
  )];

  const series = book.featured_book_series
    ? [{ name: book.featured_book_series.series.name, position: book.featured_book_series.position }]
    : undefined;

  // Prefer audio_seconds from editions, then default_audio_edition, then book itself
  const audioEdition = book.default_audio_edition;
  const bestEdition = book.editions?.find((e) => e.audio_seconds);
  const audioSeconds = bestEdition?.audio_seconds ?? audioEdition?.audio_seconds ?? book.audio_seconds;

  const genres = extractGenres(book.cached_tags);

  // Prefer ASIN from editions (more likely to have it)
  const bestAsinEdition = book.editions?.find((e) => e.asin);
  const primaryAsin = bestAsinEdition?.asin ?? audioEdition?.asin ?? undefined;

  // Collect all unique ASINs from editions for fallback lookups (e.g. Audnexus)
  const allAsins = [
    ...(book.editions ?? []).map((e) => e.asin),
    audioEdition?.asin,
  ].filter((a): a is string => !!a);
  const alternateAsins = [...new Set(allAsins)].filter((a) => a !== primaryAsin);

  return {
    title: book.title ?? '',
    subtitle: book.subtitle || undefined,
    authors,
    narrators: narrators.length > 0 ? narrators : undefined,
    series,
    description: book.description,
    publisher: audioEdition?.publisher?.name,
    publishedDate: book.release_date ?? (book.release_year ? String(book.release_year) : undefined),
    coverUrl: extractImageUrl(book.cached_image),
    duration: audioSeconds ? Math.round(audioSeconds / 60) : undefined,
    genres,
    asin: primaryAsin,
    alternateAsins: alternateAsins.length > 0 ? alternateAsins : undefined,
    isbn: audioEdition?.isbn_13 ?? undefined,
  };
}

function mapAuthorDetail(author: HardcoverAuthorDetail): Record<string, unknown> {
  return {
    name: author.name,
    description: author.bio,
    imageUrl: extractImageUrl(author.cached_image),
  };
}

function mapContributionBook(book: NonNullable<HardcoverAuthorDetail['contributions']>[number]['book']): Record<string, unknown> {
  if (!book) return { title: '', authors: [] };

  const series = book.featured_book_series
    ? [{ name: book.featured_book_series.series.name, position: book.featured_book_series.position }]
    : undefined;

  return {
    title: book.title,
    authors: [],
    series,
    publishedDate: book.release_year ? String(book.release_year) : undefined,
    coverUrl: extractImageUrl(book.cached_image),
    duration: book.audio_seconds ? Math.round(book.audio_seconds / 60) : undefined,
  };
}

function mapSeriesDetail(series: HardcoverSeriesDetail): Record<string, unknown> {
  const books: Record<string, unknown>[] = [];

  for (const entry of series.book_series ?? []) {
    const b = entry.book;
    const contributors = b.cached_contributors ?? [];
    const authors = contributors.map((c) => ({ name: c.author.name }));

    books.push({
      title: b.title,
      authors,
      series: [{ name: series.name, position: entry.position }],
      publishedDate: b.release_year ? String(b.release_year) : undefined,
      coverUrl: extractImageUrl(b.cached_image),
      duration: b.audio_seconds ? Math.round(b.audio_seconds / 60) : undefined,
    });
  }

  return {
    name: series.name,
    description: series.description ?? undefined,
    books,
  };
}
