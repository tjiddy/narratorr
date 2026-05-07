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
  matchResult?: MatchResult | undefined;
}
