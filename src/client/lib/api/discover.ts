import type { SuggestionReason, SuggestionRowResponse } from '../../../shared/schemas/discovery.js';
import { fetchApi } from './client.js';

/** @deprecated Use SuggestionRowResponse directly — alias preserved for existing consumers. */
export type SuggestionRow = SuggestionRowResponse;

export type DiscoverStats = Partial<Record<SuggestionReason, number>>;

export interface MarkAddedResult {
  suggestion: SuggestionRowResponse;
}

export interface RefreshResult {
  added: number;
  removed: number;
  warnings: string[];
}

export const discoverApi = {
  getDiscoverSuggestions: () =>
    fetchApi<SuggestionRowResponse[]>('/discover/suggestions'),

  markDiscoverSuggestionAdded: (id: number) =>
    fetchApi<MarkAddedResult>(`/discover/suggestions/${id}/mark-added`, {
      method: 'POST',
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
