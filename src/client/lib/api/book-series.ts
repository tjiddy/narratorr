export interface BookSeriesMemberCard {
  hardcoverBookId: number | null;
  slug: string | null;
  title: string;
  position: number | null;
  imageUrl: string | null;
  inLibrary: boolean;
  libraryBookId: number | null;
}

export interface BookSeriesCardData {
  /** Local `series` row id; null in no-key mode or when no cached row exists. */
  id: number | null;
  name: string;
  hardcoverSeriesId: number | null;
  /** Persisted Hardcover `series.author.name`; null in no-key mode. */
  seriesAuthor: string | null;
  lastFetchedAt: string | null;
  members: BookSeriesMemberCard[];
}

export interface RefreshBookSeriesResponse {
  series: BookSeriesCardData | null;
}

export interface HardcoverSeriesCandidate {
  id: number;
  name: string;
  slug: string | null;
  authorName: string | null;
  booksCount: number;
  imageUrl: string | null;
}
