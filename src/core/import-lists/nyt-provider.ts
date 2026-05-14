import { z } from 'zod';
import type { ImportListProvider, ImportListItem } from './types.js';
import { ImportListError } from './errors.js';
import { getErrorMessage } from '../../shared/error-message.js';
import { fetchWithTimeout } from '../utils/network-service.js';
import { IMPORT_LIST_TIMEOUT_MS } from '../utils/constants.js';

export interface NytConfig {
  apiKey: string;
  list: string; // e.g., 'audio-fiction', 'audio-nonfiction'
}

const nytBookSchema = z.object({
  title: z.string().nullish(),
  author: z.string().nullish(),
  primary_isbn13: z.string().nullish(),
  primary_isbn10: z.string().nullish(),
  book_image: z.string().nullish(),
  description: z.string().nullish(),
}).passthrough();

// Lowercased mid-title (NOT the first word, NOT the first word after ':').
// Always Cased at title-start so "THE WAY OF KINGS" → "The Way of Kings".
const TITLE_CASE_LOWERCASE = new Set([
  'a', 'an', 'and', 'as', 'at', 'but', 'by', 'for', 'from', 'in', 'into', 'nor',
  'of', 'on', 'or', 'so', 'the', 'to', 'up', 'with', 'yet',
]);

// Common short English words (2-3 letters). Used to disambiguate acronyms
// ("GMA" → keep uppercase) from short verbs/pronouns/nouns ("AM" → "Am") in
// all-caps input. Limited to 2-3 chars because the acronym heuristic only
// fires for short tokens — 4+ letter tokens always Cap-case (Book, Club).
const COMMON_SHORT_WORDS = new Set([
  // 2 letters
  'am', 'an', 'as', 'at', 'be', 'by', 'do', 'go', 'he', 'hi', 'if', 'in', 'is',
  'it', 'me', 'my', 'no', 'of', 'oh', 'on', 'or', 'ow', 'pa', 'so', 'to', 'up',
  'us', 'we',
  // 3 letters
  'all', 'and', 'any', 'are', 'bad', 'big', 'but', 'can', 'did', 'die', 'dog',
  'eat', 'end', 'eye', 'far', 'few', 'for', 'fun', 'get', 'god', 'got', 'had',
  'has', 'her', 'him', 'his', 'hit', 'how', 'its', 'job', 'key', 'kid', 'law',
  'led', 'let', 'lie', 'man', 'may', 'men', 'mom', 'new', 'nor', 'not', 'now',
  'off', 'old', 'one', 'our', 'out', 'own', 'put', 'ran', 'red', 'run', 'sat',
  'saw', 'say', 'see', 'set', 'she', 'sit', 'son', 'sun', 'ten', 'the', 'too',
  'top', 'try', 'two', 'use', 'war', 'was', 'way', 'who', 'why', 'win', 'won',
  'yes', 'yet', 'you',
]);

/**
 * Title-case an ALL-CAPS-ish string (NYT bestseller titles).
 *
 * Rules:
 * - Pass through when the input already contains a lowercase letter
 *   (publisher-supplied casing wins).
 * - First word and the first word after `:` are always Cased.
 * - Mid-title prepositions/articles in {@link TITLE_CASE_LOWERCASE} stay lowercase.
 * - Single-letter `i` → `I`.
 * - Short uppercase tokens (≤4 alpha chars) NOT in {@link COMMON_SHORT_WORDS}
 *   are treated as acronyms and stay uppercase ("GMA" → "GMA").
 * - Everything else gets `Word` casing.
 */
export function titleCase(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) return '';
  if (/[a-z]/.test(trimmed)) return trimmed;

  const tokens = trimmed.split(/\s+/);
  let afterBoundary = true;
  return tokens.map((tok) => {
    const cased = caseWord(tok, afterBoundary);
    afterBoundary = tok.endsWith(':');
    return cased;
  }).join(' ');
}

function caseWord(word: string, alwaysCapitalize: boolean): string {
  if (!word) return word;
  const lower = word.toLowerCase();
  const colon = lower.endsWith(':');
  const bare = colon ? lower.slice(0, -1) : lower;
  const trailing = colon ? ':' : '';

  if (!alwaysCapitalize && TITLE_CASE_LOWERCASE.has(bare)) {
    return `${bare}${trailing}`;
  }

  // Acronym heuristic: 2-3 char tokens whose lowercased form isn't a common
  // English word stay uppercase ("GMA" stays "GMA", "AM" → "Am").
  const alpha = bare.replace(/[^a-z]/g, '');
  if (alpha.length >= 2 && alpha.length <= 3 && !COMMON_SHORT_WORDS.has(alpha)) {
    return `${bare.toUpperCase()}${trailing}`;
  }

  return `${capitalize(bare)}${trailing}`;
}

function capitalize(s: string): string {
  if (!s) return s;
  return s.charAt(0).toUpperCase() + s.slice(1);
}

const nytResponseSchema = z.object({
  results: z.object({
    books: z.array(nytBookSchema),
  }).passthrough(),
}).passthrough();

export class NytProvider implements ImportListProvider {
  readonly type = 'nyt';
  readonly name = 'NYT Bestsellers';

  private apiKey: string;
  private list: string;

  constructor(config: NytConfig) {
    this.apiKey = config.apiKey;
    this.list = config.list;
  }

  async fetchItems(): Promise<ImportListItem[]> {
    const url = `https://api.nytimes.com/svc/books/v3/lists/current/${this.list}.json?api-key=${this.apiKey}`;
    const res = await fetchWithTimeout(url, {}, IMPORT_LIST_TIMEOUT_MS);

    if (res.status === 429) {
      throw new ImportListError(this.name, 'NYT API rate limit exceeded');
    }

    if (!res.ok) {
      throw new ImportListError(this.name, `NYT API returned ${res.status}: ${res.statusText}`);
    }

    const raw: unknown = await res.json();
    const parsed = nytResponseSchema.safeParse(raw);
    if (!parsed.success) {
      throw new ImportListError(
        this.name,
        `NYT returned unexpected response: ${parsed.error.issues[0]?.message ?? 'unknown'}`,
        { cause: parsed.error },
      );
    }
    const books = parsed.data.results.books;

    const items: ImportListItem[] = [];
    for (const book of books) {
      if (!book.title) continue;
      items.push({
        title: titleCase(book.title),
        author: book.author || undefined,
        isbn: book.primary_isbn13 || book.primary_isbn10 || undefined,
        coverUrl: book.book_image || undefined,
        description: book.description || undefined,
      });
    }
    return items;
  }

  async test(): Promise<{ success: boolean; message?: string }> {
    try {
      const url = `https://api.nytimes.com/svc/books/v3/lists/current/${this.list}.json?api-key=${this.apiKey}`;
      const res = await fetchWithTimeout(url, {}, IMPORT_LIST_TIMEOUT_MS);

      if (res.status === 401 || res.status === 403) {
        return { success: false, message: 'Invalid API key' };
      }

      if (!res.ok) {
        return { success: false, message: `API returned ${res.status}: ${res.statusText}` };
      }

      const raw: unknown = await res.json();
      const parsed = nytResponseSchema.safeParse(raw);
      if (!parsed.success) {
        return { success: false, message: `Validation failed: ${parsed.error.issues[0]?.message ?? 'unknown'}` };
      }

      return { success: true };
    } catch (error: unknown) {
      return { success: false, message: `Connection failed: ${getErrorMessage(error)}` };
    }
  }
}
