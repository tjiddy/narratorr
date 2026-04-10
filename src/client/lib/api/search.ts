import { fetchApi } from './client.js';
import { type Download } from './activity.js';
import type { SearchResult } from '../../../core/indexers/types.js';
import { type GrabPayload } from '../../../shared/schemas/search.js';

export type { SearchResult, DownloadProtocol } from '../../../core/indexers/types.js';

export interface SearchContext {
  author?: string;
  title?: string;
  bookDuration?: number;
}

export interface SearchResponse {
  results: SearchResult[];
  durationUnknown: boolean;
  unsupportedResults: {
    count: number;
    titles: string[];
  };
}

export const searchApi = {
  searchBooks: (query: string, context?: SearchContext) => {
    const params = new URLSearchParams({ q: query });
    if (context?.author) params.set('author', context.author);
    if (context?.title) params.set('title', context.title);
    if (context?.bookDuration) params.set('bookDuration', String(context.bookDuration));
    return fetchApi<SearchResponse>(`/search?${params.toString()}`);
  },

  cancelSearchIndexer: (sessionId: string, indexerId: number) =>
    fetchApi<{ cancelled: boolean }>(`/search/stream/${sessionId}/cancel/${indexerId}`, {
      method: 'POST',
    }),

  searchGrab: (params: GrabPayload) =>
    fetchApi<Download>('/search/grab', {
      method: 'POST',
      body: JSON.stringify(params),
    }),
};
