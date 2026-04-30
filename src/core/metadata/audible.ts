import { z } from 'zod';
import { BookMetadataSchema, AuthorMetadataSchema, SeriesMetadataSchema } from './schemas.js';
import { MetadataError, RateLimitError, TransientError } from './errors.js';
import { REGION_LANGUAGES } from './region-languages.js';
import { AUDIBLE_TIMEOUT_MS } from '../utils/constants.js';
import { fetchWithTimeout } from '../utils/fetch-with-timeout.js';
import { RESPONSE_CAP_METADATA } from '../utils/response-caps.js';
import { getErrorMessage } from '../../shared/error-message.js';
import type {
  MetadataSearchProvider,
  BookMetadata,
  AuthorMetadata,
  SeriesMetadata,
  SearchBooksOptions,
  SearchBooksResult,
} from './types.js';

/** Default wait time (ms) when rate-limited without a Retry-After header. */
const DEFAULT_RATE_LIMIT_WAIT_MS = 60_000;

export interface AudibleConfig {
  region?: string;
}

const REGION_TLDS: Record<string, string> = {
  us: '.com',
  ca: '.ca',
  uk: '.co.uk',
  au: '.com.au',
  fr: '.fr',
  de: '.de',
  jp: '.co.jp',
  it: '.it',
  in: '.in',
  es: '.es',
};


const REQUEST_TIMEOUT_MS = AUDIBLE_TIMEOUT_MS;
const MAX_RESULTS = 10;
const RESPONSE_GROUPS = 'contributors,product_desc,media,product_extended_attrs,series';
const IMAGE_SIZES = '500,1024';

// Raw-response schemas at the wrapper layer — fail at the boundary on HTML
// interstitials, rate-limit pages, or shape changes instead of mid-mapping.
const audibleProductSchema = z.object({
  asin: z.string().nullish(),
  title: z.string().nullish(),
  subtitle: z.string().nullish(),
  authors: z.array(z.object({ asin: z.string().nullish(), name: z.string() }).passthrough()).nullish(),
  narrators: z.array(z.object({ name: z.string() }).passthrough()).nullish(),
  publisher_name: z.string().nullish(),
  publisher_summary: z.string().nullish(),
  merchandising_summary: z.string().nullish(),
  release_date: z.string().nullish(),
  issue_date: z.string().nullish(),
  runtime_length_min: z.number().nullish(),
  language: z.string().nullish(),
  product_images: z.record(z.string(), z.string()).nullish(),
  series: z.array(z.object({
    asin: z.string().nullish(),
    sequence: z.string().nullish(),
    title: z.string().nullish(),
  }).passthrough()).nullish(),
  format_type: z.string().nullish(),
}).passthrough();

const audibleProductsResponseSchema = z.object({
  products: z.array(audibleProductSchema).optional(),
}).passthrough();

const audibleProductDetailResponseSchema = z.object({
  product: audibleProductSchema.optional(),
}).passthrough();

export class AudibleProvider implements MetadataSearchProvider {
  readonly name: string;
  readonly type = 'audible';

  private tld: string;
  private preferredLanguage: string;
  private baseUrl: string;

  constructor(config: AudibleConfig = {}) {
    const region = config.region ?? 'us';
    this.tld = REGION_TLDS[region] ?? '.com';
    this.preferredLanguage = REGION_LANGUAGES[region] ?? 'english';
    this.name = `Audible${this.tld}`;
    this.baseUrl = process.env.AUDIBLE_BASE_URL ?? `https://api.audible${this.tld}`;
  }

  async searchBooks(query: string, options?: SearchBooksOptions): Promise<SearchBooksResult> {
    const params = new URLSearchParams({
      num_results: String(options?.maxResults ?? MAX_RESULTS),
      products_sort_by: 'Relevance',
      response_groups: RESPONSE_GROUPS,
      image_sizes: IMAGE_SIZES,
    });

    // Use structured title/author params when available; fall back to keywords blob
    if (options?.title) {
      params.set('title', options.title);
      if (options.author) params.set('author', options.author);
    } else if (options?.author) {
      params.set('author', options.author);
    } else {
      params.set('keywords', query);
    }

    const products = await this.fetchProducts(params);
    const rawCount = products.length;
    const books: BookMetadata[] = [];
    for (const product of products) {
      const mapped = mapProduct(product);
      const result = BookMetadataSchema.safeParse(mapped);
      if (result.success) books.push(result.data);
    }

    // Sort preferred-language results first (Audible API doesn't support language filtering)
    const preferred = this.preferredLanguage;
    books.sort((a, b) => {
      const aMatch = a.language?.toLowerCase() === preferred ? 0 : 1;
      const bMatch = b.language?.toLowerCase() === preferred ? 0 : 1;
      return aMatch - bMatch;
    });

    return { books, rawCount };
  }

  async searchAuthors(query: string): Promise<AuthorMetadata[]> {
    // Audible doesn't have a dedicated author search — extract from book results
    const { books } = await this.searchBooks(query);
    const authorMap = new Map<string, AuthorMetadata>();
    for (const book of books) {
      for (const authorRef of book.authors) {
        if (!authorMap.has(authorRef.name)) {
          const mapped = AuthorMetadataSchema.safeParse({
            name: authorRef.name,
            asin: authorRef.asin,
          });
          if (mapped.success) authorMap.set(authorRef.name, mapped.data);
        }
      }
    }
    return Array.from(authorMap.values());
  }

  async searchSeries(query: string): Promise<SeriesMetadata[]> {
    // Audible doesn't have a dedicated series search — extract from book results
    const { books } = await this.searchBooks(query);
    const seriesMap = new Map<string, SeriesMetadata>();
    for (const book of books) {
      for (const seriesRef of book.series ?? []) {
        if (!seriesMap.has(seriesRef.name)) {
          const mapped = SeriesMetadataSchema.safeParse({
            name: seriesRef.name,
            asin: seriesRef.asin,
            books: [],
          });
          if (mapped.success) seriesMap.set(seriesRef.name, mapped.data);
        }
      }
    }
    return Array.from(seriesMap.values());
  }

  async getBook(asin: string): Promise<BookMetadata | null> {
    const params = new URLSearchParams({
      response_groups: RESPONSE_GROUPS,
      image_sizes: IMAGE_SIZES,
    });

    const product = await this.fetchProduct(asin, params);
    if (!product) return null;

    const mapped = mapProduct(product);
    const result = BookMetadataSchema.safeParse(mapped);
    return result.success ? result.data : null;
  }

  async test(): Promise<{ success: boolean; message?: string }> {
    try {
      const params = new URLSearchParams({
        title: 'test',
        num_results: '1',
        products_sort_by: 'Relevance',
        response_groups: RESPONSE_GROUPS,
        image_sizes: IMAGE_SIZES,
      });
      const data = await this.request(
        `${this.baseUrl}/1.0/catalog/products?${params}`,
        audibleProductsResponseSchema,
      );
      if (data && Array.isArray(data.products)) {
        return { success: true, message: `Connected to Audible (${this.name})` };
      }
      return { success: false, message: 'No response from Audible API' };
    } catch (error: unknown) {
      return {
        success: false,
        message: getErrorMessage(error),
      };
    }
  }

  private async fetchProducts(params: URLSearchParams): Promise<AudibleProduct[]> {
    const url = `${this.baseUrl}/1.0/catalog/products?${params}`;
    const data = await this.request(url, audibleProductsResponseSchema);
    return (data?.products ?? []) as AudibleProduct[];
  }

  private async fetchProduct(asin: string, params: URLSearchParams): Promise<AudibleProduct | null> {
    const url = `${this.baseUrl}/1.0/catalog/products/${asin}?${params}`;
    const data = await this.request(url, audibleProductDetailResponseSchema);
    return (data?.product ?? null) as AudibleProduct | null;
  }

  private async request<S extends z.ZodTypeAny>(url: string, schema: S): Promise<z.infer<S> | null> {
    try {
      const res = await fetchWithTimeout(url, { maxBodyBytes: RESPONSE_CAP_METADATA }, REQUEST_TIMEOUT_MS);
      if (res.status === 429) {
        const retryAfter = res.headers.get('Retry-After');
        const waitMs = retryAfter ? parseInt(retryAfter, 10) * 1000 : DEFAULT_RATE_LIMIT_WAIT_MS;
        throw new RateLimitError(waitMs, this.name);
      }
      if (res.status >= 500) {
        throw new TransientError(this.name, `HTTP ${res.status} ${res.statusText}`);
      }
      if (!res.ok) return null;
      const raw: unknown = await res.json();
      const parsed = schema.safeParse(raw);
      if (!parsed.success) {
        throw new MetadataError(
          this.name,
          `Audible returned unexpected response: ${parsed.error.issues[0]?.message ?? 'unknown'}`,
          { cause: parsed.error },
        );
      }
      return parsed.data;
    } catch (error: unknown) {
      if (error instanceof RateLimitError) throw error;
      if (error instanceof TransientError) throw error;
      if (error instanceof MetadataError) throw error;
      throw new TransientError(this.name, getErrorMessage(error));
    }
  }
}

// ---------------------------------------------------------------------------
// Internal response shapes
// ---------------------------------------------------------------------------

interface AudibleProduct {
  asin?: string;
  title?: string;
  subtitle?: string;
  authors?: Array<{ asin?: string; name: string }>;
  narrators?: Array<{ name: string }>;
  publisher_name?: string;
  publisher_summary?: string;
  merchandising_summary?: string;
  release_date?: string;
  issue_date?: string;
  runtime_length_min?: number;
  language?: string;
  product_images?: Record<string, string>;
  series?: Array<{
    asin?: string;
    sequence?: string;
    title?: string;
  }>;
  format_type?: string;
}

// ---------------------------------------------------------------------------
// Mapping helpers
// ---------------------------------------------------------------------------

// eslint-disable-next-line complexity -- API response mapping with nullable field handling
function mapProduct(product: AudibleProduct): Record<string, unknown> {
  const authors = (product.authors ?? []).map((a) => ({
    name: a.name,
    asin: a.asin || undefined,
  }));

  const narrators = (product.narrators ?? []).map((n) => n.name);

  const series = (product.series ?? [])
    .filter((s) => s.title)
    .map((s) => ({
      name: cleanTitle(s.title!),
      position: parseSeriesPosition(s.sequence),
      asin: s.asin || undefined,
    }));

  // Use the largest available product image
  const coverUrl = extractCoverUrl(product.product_images);

  // Clean HTML description — keep structural/formatting tags, strip junk
  const description = cleanHtml(
    product.publisher_summary ?? product.merchandising_summary,
  );

  // Preserve full release_date or issue_date for sorting precision
  const publishedDate = product.release_date ?? product.issue_date ?? undefined;

  return {
    asin: product.asin || undefined,
    title: cleanTitle(product.title ?? ''),
    subtitle: product.subtitle || undefined,
    authors,
    narrators: narrators.length > 0 ? narrators : undefined,
    series: series.length > 0 ? series : undefined,
    description: description || undefined,
    publisher: product.publisher_name || undefined,
    publishedDate,
    language: product.language ? product.language.toLowerCase() : undefined,
    coverUrl,
    duration: product.runtime_length_min && !isNaN(product.runtime_length_min)
      ? product.runtime_length_min
      : undefined,
  };
}

/** Parse series position from Audible's sequence string (e.g. "2", "1.5", "Book 3"). */
function parseSeriesPosition(sequence?: string): number | undefined {
  if (!sequence) return undefined;
  const match = sequence.match(/(\d+(?:\.\d+)?)/);
  return match ? parseFloat(match[1]) : undefined;
}

/** Extract the best cover URL from product_images (prefer largest). */
function extractCoverUrl(images?: Record<string, string>): string | undefined {
  if (!images) return undefined;
  // Keys are size numbers like "500", "1024" — pick the largest
  const sizes = Object.keys(images)
    .map(Number)
    .filter((n) => !isNaN(n))
    .sort((a, b) => b - a);
  return sizes.length > 0 ? images[String(sizes[0])] : undefined;
}

/** Clean HTML — keep safe structural/formatting tags, strip everything else. */
function cleanHtml(html?: string): string | undefined {
  if (!html) return undefined;
  const ALLOWED_TAGS = new Set(['p', 'br', 'b', 'strong', 'i', 'em', 'ul', 'ol', 'li']);
  const cleaned = html
    .replace(/<\/?([a-z][a-z0-9]*)\b[^>]*\/?>/gi, (_match, tag: string) => {
      return ALLOWED_TAGS.has(tag.toLowerCase()) ? _match : '';
    })
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return cleaned || undefined;
}

/** Clean title — remove Audible-appended suffixes like ", Book 2" and "(Narrated by ...)". */
function cleanTitle(title: string): string {
  return title
    .replace(/\s*\(Narrated by [^)]+\)/i, '')
    .replace(/,?\s*Book\s+\d+$/i, '')
    .trim();
}
