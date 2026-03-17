import { z } from 'zod';

// ---------------------------------------------------------------------------
// Schema — single source of truth for suggestion reason values
// ---------------------------------------------------------------------------

export const suggestionReasonSchema = z.enum(['author', 'series', 'genre', 'narrator', 'diversity']);

export type SuggestionReason = z.infer<typeof suggestionReasonSchema>;

/** All reason values as a plain array (derived from schema). */
export const SUGGESTION_REASONS = suggestionReasonSchema.options;

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
