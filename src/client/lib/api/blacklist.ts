import { fetchApi } from './client.js';

export interface BlacklistEntry {
  id: number;
  bookId?: number;
  infoHash: string;
  title: string;
  reason?: 'wrong_content' | 'bad_quality' | 'wrong_narrator' | 'spam' | 'other' | 'download_failed' | 'infrastructure_error';
  note?: string;
  blacklistType: 'temporary' | 'permanent';
  expiresAt?: string | null;
  blacklistedAt: string;
}

export const blacklistApi = {
  getBlacklist: () => fetchApi<{ data: BlacklistEntry[]; total: number }>('/blacklist'),
  addToBlacklist: (data: {
    infoHash: string;
    title: string;
    bookId?: number;
    reason?: BlacklistEntry['reason'];
    note?: string;
    blacklistType?: 'temporary' | 'permanent';
  }) =>
    fetchApi<BlacklistEntry>('/blacklist', {
      method: 'POST',
      body: JSON.stringify(data),
    }),
  removeFromBlacklist: (id: number) =>
    fetchApi<{ success: boolean }>(`/blacklist/${id}`, { method: 'DELETE' }),
  toggleBlacklistType: (id: number, blacklistType: 'temporary' | 'permanent') =>
    fetchApi<BlacklistEntry>(`/blacklist/${id}`, {
      method: 'PATCH',
      body: JSON.stringify({ blacklistType }),
    }),
};
