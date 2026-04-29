import type { SuggestionRowResponse } from '../../../shared/schemas/discovery.js';
import { fetchApi } from './client.js';

/** @deprecated Use SuggestionRowResponse directly — alias preserved for existing consumers. */
export type SuggestionRow = SuggestionRowResponse;

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

  refreshDiscover: () =>
    fetchApi<RefreshResult>('/discover/refresh', {
      method: 'POST',
    }),
};
