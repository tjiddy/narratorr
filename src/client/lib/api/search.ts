import { fetchApi } from './client.js';
import { type Download } from './activity.js';

export interface SearchResult {
  title: string;
  rawTitle?: string;
  author?: string;
  narrator?: string;
  protocol: 'torrent' | 'usenet';
  downloadUrl?: string;
  infoHash?: string;
  size?: number;
  seeders?: number;
  leechers?: number;
  grabs?: number;
  indexer: string;
  detailsUrl?: string;
  coverUrl?: string;
  matchScore?: number;
}

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

  searchGrab: (params: {
    downloadUrl: string;
    title: string;
    protocol?: 'torrent' | 'usenet';
    bookId?: number;
    indexerId?: number;
    size?: number;
    seeders?: number;
  }) =>
    fetchApi<Download>('/search/grab', {
      method: 'POST',
      body: JSON.stringify(params),
    }),
};
