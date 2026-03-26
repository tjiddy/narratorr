import type { BookMetadata, DiscoveredBook, MatchResult } from '@/lib/api';

export interface BookEditState {
  title: string;
  author: string;
  series: string;
  coverUrl?: string;
  asin?: string;
  metadata?: BookMetadata;
}

export interface ImportRow {
  book: DiscoveredBook;
  selected: boolean;
  edited: BookEditState;
  matchResult?: MatchResult;
}
