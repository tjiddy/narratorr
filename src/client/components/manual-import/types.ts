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
  readonly matchResult?: MatchResult | undefined;
  /**
   * Transient, client-only logical generation of this row's match evidence (#2055).
   * Stamped by every write that installs, replaces, or clears `matchResult`, from a
   * per-hook counter that only ever increments — so a re-scan or a Restart that rebuilds a
   * row for the same folder path can never reproduce a value an in-flight chapter-
   * corroboration request already captured. The async corroboration patch is the one write
   * that does NOT stamp: it is the terminal write for the generation it answers.
   *
   * Optional so existing inline row fixtures need no change; an undefined stamp on either
   * side makes the staleness guard reject, which is the safe direction (the row simply
   * keeps its synchronous verdict).
   *
   * Both this and `matchResult` are `readonly` (#2060) so the pair can only ever be set by
   * CONSTRUCTION — `stampRow` for every write that installs, replaces or clears the match, and
   * `applyCorroboration` for the terminal patch. That blocks direct mutation only; a
   * structurally-compatible mutable alias still writes freely (TypeScript ignores `readonly`
   * in assignability), as do `Object.defineProperty` / `Reflect.set`. Closing that gap is
   * #2182.
   */
  readonly matchGeneration?: number | undefined;
}
