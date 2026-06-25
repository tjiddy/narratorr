import type { BookMetadata, DiscoveredBook, MatchResult } from '@/lib/api';

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
  /**
   * True once the user commits a fix through the edit modal (`handleEdit`). A
   * later, lower-confidence match merge must NOT force-uncheck such a row — the
   * #1318 safe-default flip only applies to rows the user has not explicitly
   * fixed. Bare checkbox toggles deliberately do NOT set this (#1374).
   */
  userEdited: boolean;
  matchResult?: MatchResult | undefined;
}
