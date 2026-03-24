import type { LibrarySignals } from './discovery.service.js';

const MAX_AUTHOR_STRENGTH = 5;

interface BookRow {
  book: {
    id: number;
    genres: string[] | null;
    duration: number | null;
    seriesName: string | null;
    seriesPosition: number | null;
  };
  authorName: string | null;
}

interface NarratorRow {
  bookId: number;
  narratorName: string;
}

/**
 * Extract library signals from imported book rows and narrator junction rows.
 * Pure function — no DB access, no side effects.
 */
export function extractSignals(importedBooks: BookRow[], narratorRows: NarratorRow[]): LibrarySignals {
  const authorAffinity = new Map<string, { count: number; strength: number; name: string }>();
  const genreDistribution = new Map<string, number>();
  const durations: number[] = [];
  const seriesMap = new Map<string, { authorName: string; positions: number[] }>();

  for (const row of importedBooks) {
    accumulateBookSignals(row, authorAffinity, genreDistribution, durations, seriesMap);
  }

  const seriesGaps = computeSeriesGaps(seriesMap);
  const durationStats = computeDurationStats(durations);
  const narratorAffinity = computeNarratorAffinity(importedBooks.map(r => r.book.id), narratorRows);

  return { authorAffinity, genreDistribution, seriesGaps, narratorAffinity, durationStats };
}

function accumulateBookSignals(
  row: BookRow,
  authorAffinity: Map<string, { count: number; strength: number; name: string }>,
  genreDistribution: Map<string, number>,
  durations: number[],
  seriesMap: Map<string, { authorName: string; positions: number[] }>,
) {
  const { book } = row;
  const authorName = row.authorName ?? 'Unknown';

  // Author affinity
  const existing = authorAffinity.get(authorName);
  if (existing) {
    existing.count += 1;
    existing.strength = Math.min(existing.count / MAX_AUTHOR_STRENGTH, 1.0);
  } else {
    authorAffinity.set(authorName, {
      count: 1,
      strength: Math.min(1 / MAX_AUTHOR_STRENGTH, 1.0),
      name: authorName,
    });
  }

  // Genre distribution
  if (book.genres && Array.isArray(book.genres)) {
    for (const genre of book.genres) {
      genreDistribution.set(genre, (genreDistribution.get(genre) ?? 0) + 1);
    }
  }

  // Duration
  if (book.duration != null) {
    durations.push(book.duration);
  }

  // Series tracking
  if (book.seriesName && book.seriesPosition != null) {
    const entry = seriesMap.get(book.seriesName);
    if (entry) {
      entry.positions.push(book.seriesPosition);
    } else {
      seriesMap.set(book.seriesName, { authorName, positions: [book.seriesPosition] });
    }
  }
}

/**
 * Build narrator affinity counts from junction table rows.
 * Each narrator is counted once per book (deduped by bookId within the filtered set).
 */
function computeNarratorAffinity(importedBookIds: number[], narratorRows: NarratorRow[]): Map<string, number> {
  const importedSet = new Set(importedBookIds);
  const counts = new Map<string, number>();

  // Track (narratorName, bookId) pairs to avoid double-counting if a narrator appears twice for same book
  const seen = new Set<string>();
  for (const row of narratorRows) {
    if (!importedSet.has(row.bookId)) continue;
    const key = `${row.narratorName}|${row.bookId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    counts.set(row.narratorName, (counts.get(row.narratorName) ?? 0) + 1);
  }

  return filterNarratorThreshold(counts, 3);
}

function computeSeriesGaps(seriesMap: Map<string, { authorName: string; positions: number[] }>): LibrarySignals['seriesGaps'] {
  const gaps: LibrarySignals['seriesGaps'] = [];
  for (const [seriesName, { authorName, positions }] of seriesMap) {
    const sorted = [...positions].sort((a, b) => a - b);
    const maxOwned = sorted[sorted.length - 1];
    const missing: number[] = [];

    for (let i = Math.min(...sorted); i <= maxOwned; i++) {
      if (!sorted.includes(i) && Number.isInteger(i)) {
        missing.push(i);
      }
    }
    missing.push(maxOwned + 1);
    gaps.push({ seriesName, authorName, missingPositions: missing, maxOwned });
  }
  return gaps;
}

function computeDurationStats(durations: number[]): LibrarySignals['durationStats'] {
  if (durations.length === 0) return null;

  const sorted = [...durations].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
  const mean = durations.reduce((a, b) => a + b, 0) / durations.length;
  const variance = durations.reduce((sum, d) => sum + (d - mean) ** 2, 0) / durations.length;
  const stddev = Math.sqrt(variance);
  return { median, stddev };
}

function filterNarratorThreshold(narratorCounts: Map<string, number>, threshold: number): Map<string, number> {
  const result = new Map<string, number>();
  for (const [name, count] of narratorCounts) {
    if (count >= threshold) {
      result.set(name, count);
    }
  }
  return result;
}
