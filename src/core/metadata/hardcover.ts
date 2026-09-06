import { z } from 'zod';
import { HARDCOVER_TIMEOUT_MS } from '../utils/constants.js';
import { MAX_VARIANT_TITLE_LENGTH } from '../utils/title-variants.js';
import {
  fetchHardcoverGraphQL,
  normalizeHardcoverApiKey,
  TOP_LEVEL_LIMIT_EXCEEDED,
  type HardcoverErrorDetail,
  type HardcoverFetchOutcome,
} from '../utils/hardcover-http.js';
import { parseRetryAfterMs } from './retry-after.js';
import { normalizeMemberPosition, pickPreferredMembersByPosition } from './hardcover-member-dedup.js';
import { RateLimitError, TransientError, MetadataError } from './errors.js';
import { getErrorMessage } from '@shared/error-message.js';

const HARDCOVER_PROVIDER = 'hardcover';

// Depth watch (#2537): Hardcover's roadmap limits query depth to 3 in 2026. This query runs
// series → book_series → book → image (~4), so it breaks when that ships — as will the
// import-list provider's queries, simultaneously and for the same reason.
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

// Depth watch (#2537): same series → book_series → book → image nesting as above (~4).
const GET_SERIES_MEMBERS_BY_ID_QUERY = `
  query GetSeriesMembersById($id: Int!, $today: date!) {
    series(where: {
      id: {_eq: $id},
      canonical_id: {_is_null: true}
    }) {
      id
      name
      slug
      author { name }
      book_series(
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

// Hardcover documents lowercase `query_type` values; keep `series` lowercase.
const SEARCH_SERIES_QUERY = `
  query SearchSeries($query: String!) {
    search(query: $query, query_type: "series", per_page: 25, page: 1) {
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
  readersCount: number;
  imageUrl: string | null;
}

function isoDateToday(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Every arm except the 429 one carries the numeric status, because `mapHardcoverError` keys its
 * invalid-key hint on '401'/'403' as message substrings. `RateLimitError` is exempt: its message is
 * fixed by its constructor and the type is shared with Audible and Audnexus, and the server mapper
 * recognizes rate limiting BY TYPE, so widening it for one adapter's diagnostics would buy nothing.
 */
function mapHttpError(
  status: number,
  statusText: string,
  retryAfterHeader: string | null,
  detail: HardcoverErrorDetail,
): never {
  const suffix = detail.suffix ?? '';
  // A structural top-level-query refusal is a malformed request, not a throttle — surface it as
  // actionable whatever status Hardcover attaches, rather than looping behind "try again".
  if (detail.code === TOP_LEVEL_LIMIT_EXCEEDED) {
    throw new MetadataError(HARDCOVER_PROVIDER, `Hardcover API returned ${status}: ${statusText}${suffix}`);
  }
  if (status === 429) {
    throw new RateLimitError(parseRetryAfterMs(retryAfterHeader), HARDCOVER_PROVIDER);
  }
  if (status >= 500) {
    throw new TransientError(HARDCOVER_PROVIDER, `HTTP ${status}: ${statusText}${suffix}`);
  }
  throw new MetadataError(HARDCOVER_PROVIDER, `Hardcover API returned ${status}: ${statusText}${suffix}`);
}

function mapNetworkError(error: unknown): never {
  if (error instanceof RateLimitError || error instanceof TransientError || error instanceof MetadataError) {
    throw error;
  }
  // `instanceof Error` does NOT exclude a DrizzleQueryError, so route the Error arm through the
  // shared renderer; this message becomes operator-visible metadata-provider text (#2604 AC6).
  const message = getErrorMessage(error);
  throw new TransientError(HARDCOVER_PROVIDER, message);
}

function mapMember(entry: z.infer<typeof hardcoverBookSeriesSchema>): HardcoverMember {
  // Share normalization with the dedup grouping key.
  const position = normalizeMemberPosition(entry.position);
  return {
    hardcoverBookId: entry.book.id,
    slug: entry.book.slug ?? null,
    title: entry.book.title,
    position,
    imageUrl: entry.book.image?.url ?? null,
  };
}

/**
 * Sole member-array chokepoint. Drop overlong UGC titles before same-position selection—never
 * truncate or reject the whole response—so safe siblings survive. The picker prefers Latin-script
 * works, uses readership as tie-break, and preserves unpositioned works plus source order because
 * persistence claims library books greedily.
 */
function mapSeries(entry: z.infer<typeof hardcoverSeriesSchema>): HardcoverSeriesData {
  const withinLengthCap = (entry.book_series ?? [])
    .filter((member) => member.book.title.length <= MAX_VARIANT_TITLE_LENGTH);
  const members = pickPreferredMembersByPosition(withinLengthCap).map(mapMember);
  return {
    id: entry.id,
    name: entry.name,
    slug: entry.slug ?? null,
    authorName: entry.author?.name ?? null,
    members,
  };
}

async function executeGraphQL(apiKey: string, body: { query: string; variables?: Record<string, unknown> }): Promise<unknown> {
  let outcome: HardcoverFetchOutcome;
  try {
    // No retry budget: the metadata client's single-shot 429 disposition is a typed RateLimitError
    // that MetadataService's gate already honors.
    outcome = await fetchHardcoverGraphQL({
      apiKey,
      query: body.query,
      variables: body.variables,
      timeoutMs: HARDCOVER_TIMEOUT_MS,
      budget: null,
    });
  } catch (error: unknown) {
    mapNetworkError(error);
  }

  if (!outcome.ok) {
    mapHttpError(outcome.status, outcome.statusText, outcome.retryAfterHeader, outcome);
  }

  try {
    return await outcome.response.json();
  } catch (error: unknown) {
    throw new MetadataError(HARDCOVER_PROVIDER, `Failed to parse Hardcover response: ${getErrorMessage(error)}`);
  }
}

export class HardcoverClient {
  private readonly apiKey: string;

  constructor(apiKey: string) {
    this.apiKey = normalizeHardcoverApiKey(apiKey);
  }

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
    // Drop empty stubs and stably re-rank by readership; consumers apply their own display caps.
    const candidates = extractSearchCandidates(parsed.data.data?.search?.results)
      .filter((c) => c.booksCount > 0);
    candidates.sort((a, b) => b.readersCount - a.readersCount);
    return candidates;
  }
}

/** Accepts legacy top-level hits and Typesense hits nested under `document`. */
function extractSearchCandidates(raw: unknown): HardcoverSearchCandidate[] {
  const hits = extractHitsArray(raw);
  const out: HardcoverSearchCandidate[] = [];
  for (const hit of hits) {
    if (typeof hit !== 'object' || hit === null) continue;
    const envelope = hit as Record<string, unknown>;
    const obj = (typeof envelope.document === 'object' && envelope.document !== null
      ? envelope.document
      : envelope) as Record<string, unknown>;
    const id = pickNumber(obj.id);
    const name = typeof obj.name === 'string' ? obj.name : null;
    if (id === null || !name) continue;
    const slug = typeof obj.slug === 'string' ? obj.slug : null;
    const authorName = extractAuthorName(obj);
    const booksCount = pickNumber(obj.books_count) ?? 0;
    const readersCount = pickNumber(obj.readers_count) ?? 0;
    const imageUrl = extractImageUrl(obj);
    out.push({ id, name, slug, authorName, booksCount, readersCount, imageUrl });
  }
  return out;
}

/** Accepts direct and nested Typesense cover shapes; missing art is valid. */
function extractImageUrl(hit: Record<string, unknown>): string | null {
  const directUrl = hit.image_url;
  if (typeof directUrl === 'string' && directUrl.length > 0) return directUrl;
  for (const key of ['image', 'cached_image'] as const) {
    const candidate = hit[key];
    if (typeof candidate === 'object' && candidate !== null) {
      const url = (candidate as Record<string, unknown>).url;
      if (typeof url === 'string' && url.length > 0) return url;
    }
  }
  return null;
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
  // Typesense may expose only the singular `author_name` field.
  const authorName = hit.author_name;
  if (typeof authorName === 'string' && authorName.length > 0) return authorName;
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
