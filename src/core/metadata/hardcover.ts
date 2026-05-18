import { z } from 'zod';
import { fetchWithTimeout } from '../utils/network-service.js';
import { HARDCOVER_TIMEOUT_MS } from '../utils/constants.js';
import { RateLimitError, TransientError, MetadataError } from './errors.js';

const HARDCOVER_PROVIDER = 'hardcover';
const GRAPHQL_URL = 'https://api.hardcover.app/v1/graphql';

const GET_SERIES_MEMBERS_QUERY = `
  query GetSeriesMembers($name: String!, $author: String!, $today: date!) {
    series(where: {
      name: {_eq: $name},
      author: {name: {_eq: $author}},
      books_count: {_gt: 0},
      canonical_id: {_is_null: true}
    }) {
      id
      name
      slug
      author { name }
      book_series(
        distinct_on: position
        order_by: [{position: asc}, {book: {users_count: desc}}]
        where: {
          book: {
            canonical_id: {_is_null: true},
            is_partial_book: {_eq: false},
            release_date: {_is_null: false, _lt: $today}
          },
          compilation: {_eq: false}
        }
      ) {
        position
        book { id slug title image { url } users_count }
      }
    }
  }
`;

const GET_SERIES_MEMBERS_BY_ID_QUERY = `
  query GetSeriesMembersById($id: bigint!, $today: date!) {
    series(where: {
      id: {_eq: $id},
      canonical_id: {_is_null: true}
    }) {
      id
      name
      slug
      author { name }
      book_series(
        distinct_on: position
        order_by: [{position: asc}, {book: {users_count: desc}}]
        where: {
          book: {
            canonical_id: {_is_null: true},
            is_partial_book: {_eq: false},
            release_date: {_is_null: false, _lt: $today}
          },
          compilation: {_eq: false}
        }
      ) {
        position
        book { id slug title image { url } users_count }
      }
    }
  }
`;

const SEARCH_SERIES_QUERY = `
  query SearchSeries($query: String!) {
    search(query: $query, query_type: "series", per_page: 10, page: 1) {
      results
    }
  }
`;

const hardcoverBookSchema = z.object({
  id: z.number(),
  slug: z.string().nullish(),
  title: z.string(),
  image: z.object({ url: z.string().nullish() }).passthrough().nullish(),
  users_count: z.number().nullish(),
}).passthrough();

const hardcoverBookSeriesSchema = z.object({
  position: z.number().nullish(),
  book: hardcoverBookSchema,
}).passthrough();

const hardcoverSeriesSchema = z.object({
  id: z.number(),
  name: z.string(),
  slug: z.string().nullish(),
  author: z.object({ name: z.string().nullish() }).passthrough().nullish(),
  book_series: z.array(hardcoverBookSeriesSchema).nullish(),
}).passthrough();

const seriesMembersResponseSchema = z.object({
  data: z.object({
    series: z.array(hardcoverSeriesSchema).nullish(),
  }).passthrough().nullish(),
  errors: z.array(z.object({ message: z.string() }).passthrough()).nullish(),
}).passthrough();

const searchResultsSchema = z.object({
  data: z.object({
    search: z.object({
      results: z.unknown().nullish(),
    }).passthrough().nullish(),
  }).passthrough().nullish(),
  errors: z.array(z.object({ message: z.string() }).passthrough()).nullish(),
}).passthrough();

export interface HardcoverMember {
  hardcoverBookId: number;
  slug: string | null;
  title: string;
  position: number | null;
  imageUrl: string | null;
}

export interface HardcoverSeriesData {
  id: number;
  name: string;
  slug: string | null;
  authorName: string | null;
  members: HardcoverMember[];
}

export interface HardcoverSearchCandidate {
  id: number;
  name: string;
  slug: string | null;
  authorName: string | null;
  booksCount: number;
}

function isoDateToday(): string {
  return new Date().toISOString().slice(0, 10);
}

function mapHttpError(status: number, statusText: string, retryAfterHeader: string | null): never {
  if (status === 429) {
    const retrySeconds = retryAfterHeader ? Number(retryAfterHeader) : Number.NaN;
    const retryAfterMs = Number.isFinite(retrySeconds) && retrySeconds > 0 ? retrySeconds * 1000 : 60_000;
    throw new RateLimitError(retryAfterMs, HARDCOVER_PROVIDER);
  }
  if (status >= 500) {
    throw new TransientError(HARDCOVER_PROVIDER, `HTTP ${status}: ${statusText}`);
  }
  throw new MetadataError(HARDCOVER_PROVIDER, `Hardcover API returned ${status}: ${statusText}`);
}

function mapNetworkError(error: unknown): never {
  if (error instanceof RateLimitError || error instanceof TransientError || error instanceof MetadataError) {
    throw error;
  }
  const message = error instanceof Error ? error.message : String(error);
  throw new TransientError(HARDCOVER_PROVIDER, message);
}

function mapMember(entry: z.infer<typeof hardcoverBookSeriesSchema>): HardcoverMember {
  const position = typeof entry.position === 'number' && Number.isFinite(entry.position) ? entry.position : null;
  return {
    hardcoverBookId: entry.book.id,
    slug: entry.book.slug ?? null,
    title: entry.book.title,
    position,
    imageUrl: entry.book.image?.url ?? null,
  };
}

function mapSeries(entry: z.infer<typeof hardcoverSeriesSchema>): HardcoverSeriesData {
  const members = (entry.book_series ?? []).map(mapMember);
  return {
    id: entry.id,
    name: entry.name,
    slug: entry.slug ?? null,
    authorName: entry.author?.name ?? null,
    members,
  };
}

async function executeGraphQL(apiKey: string, body: { query: string; variables?: Record<string, unknown> }): Promise<unknown> {
  let res: Response;
  try {
    res = await fetchWithTimeout(GRAPHQL_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
    }, HARDCOVER_TIMEOUT_MS);
  } catch (error: unknown) {
    mapNetworkError(error);
  }

  if (!res.ok) {
    mapHttpError(res.status, res.statusText, res.headers.get('Retry-After'));
  }

  try {
    return await res.json();
  } catch (error: unknown) {
    throw new MetadataError(HARDCOVER_PROVIDER, `Failed to parse Hardcover response: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export class HardcoverClient {
  constructor(private readonly apiKey: string) {}

  async getSeriesMembers(name: string, author: string): Promise<HardcoverSeriesData | null> {
    const raw = await executeGraphQL(this.apiKey, {
      query: GET_SERIES_MEMBERS_QUERY,
      variables: { name, author, today: isoDateToday() },
    });
    const parsed = seriesMembersResponseSchema.safeParse(raw);
    if (!parsed.success) {
      throw new MetadataError(HARDCOVER_PROVIDER, `Hardcover returned unexpected response: ${parsed.error.issues[0]?.message ?? 'unknown'}`);
    }
    if (parsed.data.errors?.length) {
      throw new MetadataError(HARDCOVER_PROVIDER, `Hardcover GraphQL error: ${parsed.data.errors[0]!.message}`);
    }
    const seriesArray = parsed.data.data?.series ?? [];
    if (seriesArray.length === 0) return null;
    return mapSeries(seriesArray[0]!);
  }

  async getSeriesMembersById(id: number): Promise<HardcoverSeriesData | null> {
    const raw = await executeGraphQL(this.apiKey, {
      query: GET_SERIES_MEMBERS_BY_ID_QUERY,
      variables: { id, today: isoDateToday() },
    });
    const parsed = seriesMembersResponseSchema.safeParse(raw);
    if (!parsed.success) {
      throw new MetadataError(HARDCOVER_PROVIDER, `Hardcover returned unexpected response: ${parsed.error.issues[0]?.message ?? 'unknown'}`);
    }
    if (parsed.data.errors?.length) {
      throw new MetadataError(HARDCOVER_PROVIDER, `Hardcover GraphQL error: ${parsed.data.errors[0]!.message}`);
    }
    const seriesArray = parsed.data.data?.series ?? [];
    if (seriesArray.length === 0) return null;
    return mapSeries(seriesArray[0]!);
  }

  async searchSeries(query: string): Promise<HardcoverSearchCandidate[]> {
    const raw = await executeGraphQL(this.apiKey, {
      query: SEARCH_SERIES_QUERY,
      variables: { query },
    });
    const parsed = searchResultsSchema.safeParse(raw);
    if (!parsed.success) {
      throw new MetadataError(HARDCOVER_PROVIDER, `Hardcover search returned unexpected response: ${parsed.error.issues[0]?.message ?? 'unknown'}`);
    }
    if (parsed.data.errors?.length) {
      throw new MetadataError(HARDCOVER_PROVIDER, `Hardcover search error: ${parsed.data.errors[0]!.message}`);
    }
    return extractSearchCandidates(parsed.data.data?.search?.results);
  }
}

/**
 * Hardcover's `search` API returns its results envelope as a free-form JSON
 * payload (Algolia-style `{ hits: [...] }`). Extract the candidates defensively
 * — accept either an array, or a `hits` / `results` array inside an object.
 */
function extractSearchCandidates(raw: unknown): HardcoverSearchCandidate[] {
  const hits = extractHitsArray(raw);
  const out: HardcoverSearchCandidate[] = [];
  for (const hit of hits) {
    if (typeof hit !== 'object' || hit === null) continue;
    const obj = hit as Record<string, unknown>;
    const id = pickNumber(obj.id);
    const name = typeof obj.name === 'string' ? obj.name : null;
    if (id === null || !name) continue;
    const slug = typeof obj.slug === 'string' ? obj.slug : null;
    const authorName = extractAuthorName(obj);
    const booksCount = pickNumber(obj.books_count) ?? 0;
    out.push({ id, name, slug, authorName, booksCount });
  }
  return out;
}

function extractHitsArray(raw: unknown): unknown[] {
  if (Array.isArray(raw)) return raw;
  if (typeof raw === 'object' && raw !== null) {
    const obj = raw as Record<string, unknown>;
    if (Array.isArray(obj.hits)) return obj.hits;
    if (Array.isArray(obj.results)) return obj.results;
  }
  return [];
}

function extractAuthorName(hit: Record<string, unknown>): string | null {
  const author = hit.author;
  if (typeof author === 'object' && author !== null) {
    const name = (author as Record<string, unknown>).name;
    if (typeof name === 'string' && name.length > 0) return name;
  }
  const authorNames = hit.author_names;
  if (Array.isArray(authorNames) && authorNames.length > 0) {
    const first = authorNames[0];
    if (typeof first === 'string' && first.length > 0) return first;
  }
  return null;
}

function pickNumber(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string') {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return null;
}
