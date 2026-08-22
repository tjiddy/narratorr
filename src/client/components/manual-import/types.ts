import type { BadgeVariant } from '@/components/Badge';
import type { BookMetadata, DiscoveredBook, MatchResult } from '@/lib/api';

/**
 * Caller-supplied display override for a single card: a badge that outranks the card's own
 * ownership ladder, plus an optional note line. Generic by construction — the card renders the
 * label as given and owns no knowledge of which surface produced it.
 */
export interface ImportCardAnnotation {
  badge: { label: string; variant: BadgeVariant };
  note?: string | undefined;
}

export interface BookEditState {
  title: string;
  author: string;
  series: string;
  narrators?: string[] | undefined;
  seriesPosition?: number | undefined;
  coverUrl?: string | undefined;
  asin?: string | undefined;
  metadata?: BookMetadata | undefined;
}

export interface ImportRow {
  book: DiscoveredBook;
  selected: boolean;
  edited: BookEditState;
  /** Set only by a committed modal edit; checkbox toggles do not count as edits. */
  userEdited: boolean;
  readonly matchResult?: MatchResult | undefined;
  /**
   * Monotonic client-only generation stamped whenever `matchResult` is installed,
   * replaced, or cleared; corroboration applies only to its captured generation.
   * Undefined fails closed. Keep the pair readonly and use `stampRow`/
   * `applyCorroboration`; lint covers construction, not mutable-alias writes.
   */
  readonly matchGeneration?: number | undefined;
}
