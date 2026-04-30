import { z } from 'zod';
import type { ImportListProvider, ImportListItem } from './types.js';
import { ImportListError } from './errors.js';
import { getErrorMessage } from '../../shared/error-message.js';

export interface AbsConfig {
  serverUrl: string;
  apiKey: string;
  libraryId: string;
}

// `media` and `metadata` envelopes must be present; null/missing for either is a
// boundary failure (the issue's behavior-change note explicitly tightens
// `media: null` from "skip the row" to "fail validation"). Inner string fields
// can still be null — those are tolerated so legitimately untitled items map to
// "no title" and are skipped at the mapper level.
const absItemSchema = z.object({
  media: z.object({
    metadata: z.object({
      title: z.string().nullish(),
      authorName: z.string().nullish(),
      asin: z.string().nullish(),
      isbn: z.string().nullish(),
    }).passthrough(),
  }).passthrough(),
}).passthrough();

const absItemsResponseSchema = z.object({
  results: z.array(absItemSchema),
}).passthrough();

const absLibrariesResponseSchema = z.object({
  libraries: z.array(z.object({
    id: z.string(),
    name: z.string(),
  }).passthrough()),
}).passthrough();

export class AbsProvider implements ImportListProvider {
  readonly type = 'abs';
  readonly name = 'Audiobookshelf';

  private serverUrl: string;
  private apiKey: string;
  private libraryId: string;

  constructor(config: AbsConfig) {
    this.serverUrl = config.serverUrl.replace(/\/+$/, '');
    this.apiKey = config.apiKey;
    this.libraryId = config.libraryId;
  }

  async fetchItems(): Promise<ImportListItem[]> {
    const url = `${this.serverUrl}/api/libraries/${encodeURIComponent(this.libraryId)}/items`;
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${this.apiKey}` },
    });

    if (!res.ok) {
      throw new ImportListError(this.name, `ABS API returned ${res.status}: ${res.statusText}`);
    }

    const raw: unknown = await res.json();
    const parsed = absItemsResponseSchema.safeParse(raw);
    if (!parsed.success) {
      throw new ImportListError(
        this.name,
        `Audiobookshelf returned unexpected response: ${parsed.error.issues[0]?.message ?? 'unknown'}`,
        { cause: parsed.error },
      );
    }

    const items: ImportListItem[] = [];
    for (const item of parsed.data.results) {
      const meta = item.media?.metadata;
      if (!meta?.title) continue;
      items.push({
        title: meta.title,
        author: meta.authorName || undefined,
        asin: meta.asin || undefined,
        isbn: meta.isbn || undefined,
      });
    }
    return items;
  }

  async test(): Promise<{ success: boolean; message?: string }> {
    try {
      const url = `${this.serverUrl}/api/libraries`;
      const res = await fetch(url, {
        headers: { Authorization: `Bearer ${this.apiKey}` },
      });

      if (!res.ok) {
        return { success: false, message: `API returned ${res.status}: ${res.statusText}` };
      }

      const raw: unknown = await res.json();
      const parsed = absLibrariesResponseSchema.safeParse(raw);
      if (!parsed.success) {
        return {
          success: false,
          message: `Validation failed: ${parsed.error.issues[0]?.message ?? 'unknown'}`,
        };
      }
      const libraries = parsed.data.libraries;
      const found = libraries.some((lib) => lib.id === this.libraryId);

      if (!found) {
        return { success: false, message: `Library ID "${this.libraryId}" not found. Available: ${libraries.map((l) => l.name).join(', ')}` };
      }

      return { success: true };
    } catch (error: unknown) {
      return { success: false, message: `Connection failed: ${getErrorMessage(error)}` };
    }
  }
}
