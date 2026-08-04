import { fetchApi } from './client.js';
import { type Download } from './activity.js';
import type { SearchResult } from '@core/indexers/types.js';
import { type GrabPayload } from '@shared/schemas/search.js';

export type { SearchResult, DownloadProtocol } from '@core/indexers/types.js';

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
  /**
   * The winning rung's query when progressive relaxation (#2104) produced the
   * hits — absent when rung 1 (the query the user asked for) did.
   *
   * This interface is INDEPENDENT of `searchResponseSchema`, not inferred from
   * it, so it has to be kept in step by hand; `search-stream.test.ts`'s
   * compile-time compatibility guard is what catches the drift.
   */
  relaxedQuery?: string;
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
