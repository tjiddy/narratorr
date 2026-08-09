import { z } from 'zod';

export const SUGGESTION_REASONS = ['author', 'series', 'genre', 'narrator', 'diversity'] as const;

export const suggestionReasonSchema = z.enum(SUGGESTION_REASONS);
export type SuggestionReason = z.infer<typeof suggestionReasonSchema>;

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
  createdAt: string;
  /** Existing library match by ASIN or title plus primary author. */
  libraryBookId: number | null;
}
