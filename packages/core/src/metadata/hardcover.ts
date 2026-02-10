import { BookMetadataSchema, AuthorMetadataSchema, SeriesMetadataSchema } from './schemas.js';
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
    if (!data?.search?.results) return [];

    const books: BookMetadata[] = [];
    for (const hit of data.search.results) {
      const doc = hit.document;
      if (!doc) continue;
      const mapped = mapSearchBook(doc);
      const result = BookMetadataSchema.safeParse(mapped);
      if (result.success) books.push(result.data);
    }
    return books;
  }

  async searchAuthors(query: string): Promise<AuthorMetadata[]> {
    const data = await this.gql<SearchResponse>(SEARCH_QUERY, {
      q: query,
      type: 'Author',
      perPage: 15,
    });
    if (!data?.search?.results) return [];

    const authors: AuthorMetadata[] = [];
    for (const hit of data.search.results) {
      const doc = hit.document;
      if (!doc) continue;
      const mapped = mapSearchAuthor(doc);
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
    if (!data?.search?.results) return [];

    const seriesList: SeriesMetadata[] = [];
    for (const hit of data.search.results) {
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
      if (c.contribution !== 'Author' || !c.book) continue;
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
      const res = await fetch(API_URL, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: this.apiKey,
        },
        body: JSON.stringify({
          query: SEARCH_QUERY,
          variables: { q: 'test', type: 'Book', perPage: 1 },
        }),
      });
      if (!res.ok) {
        return { success: false, message: `Hardcover ${res.status}: ${res.statusText}` };
      }
      const json = (await res.json()) as { data?: SearchResponse; errors?: Array<{ message: string }> };
      if (json.errors?.length) {
        return { success: false, message: json.errors[0].message };
      }
      if (json.data?.search?.results) {
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
    try {
      const res = await fetch(API_URL, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: this.apiKey,
        },
        body: JSON.stringify({ query, variables }),
      });
      if (!res.ok) return null;
      const json = (await res.json()) as { data?: T; errors?: Array<{ message: string }> };
      if (json.errors?.length) return null;
      return (json.data as T) ?? null;
    } catch {
      return null;
    }
  }
}

// ---------------------------------------------------------------------------
// Internal response shapes
// ---------------------------------------------------------------------------

interface SearchResponse {
  search: {
    results: Array<{ document: Record<string, unknown>; text_match?: number }>;
  };
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
  audio_seconds?: number;
  rating?: number;
  cached_image?: { url: string } | string | null;
  cached_tags?: Record<string, string[]>;
  cached_contributors?: Array<{ id: number; name: string; contribution: string }>;
  contributions?: Array<{
    contribution: string;
    author: { id: number; name: string; slug: string; cached_image?: { url: string } | null };
  }>;
  featured_book_series?: {
    position: number;
    series: { id: number; name: string; slug: string };
  } | null;
  default_audio_edition?: {
    id: number;
    asin?: string;
    isbn_13?: string;
    audio_seconds?: number;
    publisher?: { name: string };
    release_date?: string;
  } | null;
  editions?: Array<{
    id: number;
    asin?: string;
    isbn_13?: string;
    audio_seconds?: number;
    publisher?: { name: string };
    release_date?: string;
  }>;
}

interface HardcoverAuthorDetail {
  id: number;
  name: string;
  slug?: string;
  bio?: string;
  books_count?: number;
  cached_image?: { url: string } | string | null;
  contributions?: Array<{
    contribution: string;
    book?: {
      id: number;
      title: string;
      slug?: string;
      release_year?: number;
      audio_seconds?: number;
      rating?: number;
      cached_image?: { url: string } | string | null;
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
  description?: string;
  books_count?: number;
  primary_books_count?: number;
  author?: { id: number; name: string; slug: string };
  book_series?: Array<{
    position: number;
    book: {
      id: number;
      title: string;
      slug?: string;
      release_year?: number;
      audio_seconds?: number;
      rating?: number;
      cached_image?: { url: string } | string | null;
      cached_contributors?: Array<{ id: number; name: string; contribution: string }>;
    };
  }>;
}

// ---------------------------------------------------------------------------
// Mapping helpers
// ---------------------------------------------------------------------------

function extractImageUrl(image: unknown): string | undefined {
  if (!image) return undefined;
  if (typeof image === 'string') return image || undefined;
  if (typeof image === 'object' && image !== null && 'url' in image) {
    return (image as { url: string }).url || undefined;
  }
  return undefined;
}

function mapSearchBook(doc: Record<string, unknown>): Record<string, unknown> {
  const isbns = doc.isbns as string[] | undefined;
  const genres = doc.genres as string[] | undefined;
  const authorNames = doc.author_names as string[] | undefined;
  const contributions = doc.contributions as Array<{ author: { name: string; id: number } }> | undefined;
  const featuredSeries = doc.featured_series as { name: string; id: number; position: number } | null | undefined;
  const audioSeconds = doc.audio_seconds as number | undefined;

  const authors = contributions?.map((c) => ({ name: c.author.name }))
    ?? authorNames?.map((name) => ({ name }))
    ?? [];

  const series = featuredSeries
    ? [{ name: featuredSeries.name, position: featuredSeries.position }]
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
  };
}

function mapSearchAuthor(doc: Record<string, unknown>): Record<string, unknown> {
  return {
    name: (doc.name as string) ?? '',
    imageUrl: extractImageUrl(doc.image),
  };
}

function mapSearchSeries(doc: Record<string, unknown>): Record<string, unknown> {
  return {
    name: (doc.name as string) ?? '',
    books: [],
  };
}

function mapBookDetail(book: HardcoverBookDetail): Record<string, unknown> {
  const authors = (book.contributions ?? [])
    .filter((c) => c.contribution === 'Author')
    .map((c) => ({ name: c.author.name }));

  const narrators = (book.contributions ?? [])
    .filter((c) => c.contribution === 'Narrator')
    .map((c) => c.author.name);

  const series = book.featured_book_series
    ? [{ name: book.featured_book_series.series.name, position: book.featured_book_series.position }]
    : undefined;

  const audioEdition = book.default_audio_edition;
  const audioSeconds = audioEdition?.audio_seconds ?? book.audio_seconds;

  const genres = book.cached_tags?.['Genre'];

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
    asin: audioEdition?.asin,
    isbn: audioEdition?.isbn_13,
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
    const authors = contributors
      .filter((c) => c.contribution === 'Author')
      .map((c) => ({ name: c.name }));

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
    description: series.description,
    books,
  };
}
