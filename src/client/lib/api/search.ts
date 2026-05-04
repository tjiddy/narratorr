import { fetchApi } from './client.js';
import { type Download } from './activity.js';
import type { SearchResult } from '../../../core/indexers/types.js';
import { type GrabPayload } from '../../../shared/schemas/search.js';

export type { SearchResult, DownloadProtocol } from '../../../core/indexers/types.js';

export interface SearchContext {
  author?: string | undefined;
  title?: string | undefined;
  bookDuration?: number | undefined;
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
