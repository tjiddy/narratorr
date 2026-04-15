import { z } from 'zod';

// ---------------------------------------------------------------------------
// Schema — single source of truth for suggestion reason values
// ---------------------------------------------------------------------------

export const SUGGESTION_REASONS = ['author', 'series', 'genre', 'narrator', 'diversity'] as const;

export const suggestionReasonSchema = z.enum(SUGGESTION_REASONS);
export type SuggestionReason = z.infer<typeof suggestionReasonSchema>;

// ---------------------------------------------------------------------------
// Registry — metadata for each reason (labels, display, etc.)
// ---------------------------------------------------------------------------

export interface SuggestionReasonMetadata {
  label: string;
}

export const SUGGESTION_REASON_REGISTRY: Record<SuggestionReason, SuggestionReasonMetadata> = {
  author: { label: 'Author' },
  series: { label: 'Series' },
  genre: { label: 'Genre' },
  narrator: { label: 'Narrator' },
  diversity: { label: 'Diversity' },
};

// ---------------------------------------------------------------------------
// API response type — models the wire contract (not the DB row)
// ---------------------------------------------------------------------------

export interface SuggestionRowResponse {
  id: number;
  asin: string;
  title: string;
  authorName: string;
  authorAsin: string | null;
  narratorName: string | null;
  coverUrl: string | null;
  duration: number | null;
  publishedDate: string | null;
  language: string | null;
  genres: string[] | null;
  seriesName: string | null;
  seriesPosition: number | null;
  reason: SuggestionReason;
  reasonContext: string;
  score: number;
  status: 'pending' | 'added' | 'dismissed';
  refreshedAt: string;
  dismissedAt: string | null;
  snoozeUntil: string | null;
  createdAt: string;
}
