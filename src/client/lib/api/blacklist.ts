import { fetchApi } from './client.js';

export interface BlacklistEntry {
  id: number;
  bookId?: number;
  infoHash: string;
  title: string;
  reason?: 'wrong_content' | 'bad_quality' | 'wrong_narrator' | 'spam' | 'other';
  note?: string;
  blacklistedAt: string;
}

export const blacklistApi = {
  getBlacklist: () => fetchApi<BlacklistEntry[]>('/blacklist'),
  addToBlacklist: (data: {
    infoHash: string;
    title: string;
    bookId?: number;
    reason?: BlacklistEntry['reason'];
    note?: string;
  }) =>
    fetchApi<BlacklistEntry>('/blacklist', {
      method: 'POST',
      body: JSON.stringify(data),
    }),
  removeFromBlacklist: (id: number) =>
    fetchApi<{ success: boolean }>(`/blacklist/${id}`, { method: 'DELETE' }),
};
