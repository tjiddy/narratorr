import { fetchApi } from './client.js';

export interface SuggestionRow {
  id: number;
  asin: string;
  title: string;
  authorName: string;
  narratorName: string | null;
  coverUrl: string | null;
  duration: number | null;
  publishedDate: string | null;
  language: string | null;
  genres: string[] | null;
  seriesName: string | null;
  seriesPosition: number | null;
  reason: 'author' | 'series' | 'genre' | 'narrator' | 'diversity';
  reasonContext: string;
  score: number;
  status: 'pending' | 'added' | 'dismissed';
  refreshedAt: string;
  dismissedAt: string | null;
  snoozeUntil: string | null;
  createdAt: string;
}

export interface DiscoverStats {
  author?: number;
  series?: number;
  genre?: number;
  narrator?: number;
  diversity?: number;
}

export interface AddSuggestionResult {
  suggestion: SuggestionRow;
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
    fetchApi<SuggestionRow[]>('/discover/suggestions'),

  addDiscoverSuggestion: (id: number) =>
    fetchApi<AddSuggestionResult>(`/discover/suggestions/${id}/add`, {
      method: 'POST',
    }),

  dismissDiscoverSuggestion: (id: number) =>
    fetchApi<SuggestionRow>(`/discover/suggestions/${id}/dismiss`, {
      method: 'POST',
    }),

  snoozeDiscoverSuggestion: (id: number, durationDays: number) =>
    fetchApi<SuggestionRow>(`/discover/suggestions/${id}/snooze`, {
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
