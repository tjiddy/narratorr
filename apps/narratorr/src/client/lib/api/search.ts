import { fetchApi } from './client.js';
import { type Download } from './activity.js';

export interface SearchResult {
  title: string;
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
}

export const searchApi = {
  search: (query: string) =>
    fetchApi<SearchResult[]>(`/search?q=${encodeURIComponent(query)}`),

  grab: (params: {
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
