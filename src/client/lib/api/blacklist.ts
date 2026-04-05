import { fetchApi } from './client.js';
import type { BlacklistReason } from '../../../shared/schemas/blacklist.js';

export interface BlacklistEntry {
  id: number;
  bookId?: number;
  infoHash?: string | null;
  guid?: string | null;
  title: string;
  reason: BlacklistReason;
  note?: string;
  blacklistType: 'temporary' | 'permanent';
  expiresAt?: string | null;
  blacklistedAt: string;
}

export interface BlacklistListParams {
  limit?: number;
  offset?: number;
}

export const blacklistApi = {
  getBlacklist: (params?: BlacklistListParams) => {
    const searchParams = new URLSearchParams();
    if (params?.limit !== undefined) searchParams.set('limit', String(params.limit));
    if (params?.offset !== undefined) searchParams.set('offset', String(params.offset));
    const qs = searchParams.toString();
    return fetchApi<{ data: BlacklistEntry[]; total: number }>(`/blacklist${qs ? `?${qs}` : ''}`);
  },
  addToBlacklist: (data: {
    infoHash?: string;
    guid?: string;
    title: string;
    bookId?: number;
    reason: BlacklistEntry['reason'];
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
