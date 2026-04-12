import type { SuggestionReason, SuggestionRowResponse } from '../../../shared/schemas/discovery.js';
import { fetchApi } from './client.js';

/** @deprecated Use SuggestionRowResponse directly — alias preserved for existing consumers. */
export type SuggestionRow = SuggestionRowResponse;

export type DiscoverStats = Partial<Record<SuggestionReason, number>>;

export interface AddSuggestionResult {
  suggestion: SuggestionRowResponse;
  book?: { id: number; title: string };
  duplicate?: boolean;
}

export interface RefreshResult {
  added: number;
  removed: number;
  warnings: string[];
}

export const discoverApi = {
  getDiscoverSuggestions: () =>
    fetchApi<SuggestionRowResponse[]>('/discover/suggestions'),

  addDiscoverSuggestion: (id: number, overrides?: { searchImmediately: boolean; monitorForUpgrades: boolean }) =>
    fetchApi<AddSuggestionResult>(`/discover/suggestions/${id}/add`, {
      method: 'POST',
      ...(overrides && {
        body: JSON.stringify(overrides),
        headers: { 'Content-Type': 'application/json' },
      }),
    }),

  dismissDiscoverSuggestion: (id: number) =>
    fetchApi<SuggestionRowResponse>(`/discover/suggestions/${id}/dismiss`, {
      method: 'POST',
    }),

  snoozeDiscoverSuggestion: (id: number, durationDays: number) =>
    fetchApi<SuggestionRowResponse>(`/discover/suggestions/${id}/snooze`, {
      method: 'POST',
      body: JSON.stringify({ durationDays }),
      headers: { 'Content-Type': 'application/json' },
    }),

  refreshDiscover: () =>
    fetchApi<RefreshResult>('/discover/refresh', {
      method: 'POST',
    }),

  getDiscoverStats: () =>
    fetchApi<DiscoverStats>('/discover/stats'),
};
