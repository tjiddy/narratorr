import { fetchApi } from './client.js';
import { type Download } from './activity.js';
import type { SearchResult } from '@core/indexers/types.js';
import { type GrabPayload } from '@shared/schemas/search.js';
import type { SearchDropSummary } from '@shared/schemas/search-stream.js';

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
   * Winning relaxed query; absent when the original query won. This manual wire
   * type is kept aligned with searchResponseSchema by a compile-time test.
   */
  relaxedQuery?: string;
  /** Why an empty result list is empty; absent when the filters removed nothing. */
  filteredOut?: SearchDropSummary;
  /** The run was torn down at its deadline; absent when the empty list is a genuine answer. */
  timedOut?: boolean;
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
