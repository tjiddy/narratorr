import type { LibrarySignals } from './discovery.service.js';

const MAX_AUTHOR_STRENGTH = 5;

interface BookRow {
  book: {
    genres: string[] | null;
    narrator: string | null;
    duration: number | null;
    seriesName: string | null;
    seriesPosition: number | null;
  };
  author: { name: string } | null;
}

/**
 * Extract library signals from imported book rows.
 * Pure function — no DB access, no side effects.
 */
export function extractSignals(importedBooks: BookRow[]): LibrarySignals {
  const authorAffinity = new Map<string, { count: number; strength: number; name: string }>();
  const genreDistribution = new Map<string, number>();
  const narratorCounts = new Map<string, number>();
  const durations: number[] = [];
  const seriesMap = new Map<string, { authorName: string; positions: number[] }>();

  for (const row of importedBooks) {
    accumulateBookSignals(row, authorAffinity, genreDistribution, narratorCounts, durations, seriesMap);
  }

  const seriesGaps = computeSeriesGaps(seriesMap);
  const durationStats = computeDurationStats(durations);
  const narratorAffinity = filterNarratorThreshold(narratorCounts, 3);

  return { authorAffinity, genreDistribution, seriesGaps, narratorAffinity, durationStats };
}

function accumulateBookSignals(
  row: BookRow,
  authorAffinity: Map<string, { count: number; strength: number; name: string }>,
  genreDistribution: Map<string, number>,
  narratorCounts: Map<string, number>,
  durations: number[],
  seriesMap: Map<string, { authorName: string; positions: number[] }>,
) {
  const { book, author } = row;
  const authorName = author?.name ?? 'Unknown';

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

  // Narrator affinity
  if (book.narrator) {
    narratorCounts.set(book.narrator, (narratorCounts.get(book.narrator) ?? 0) + 1);
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
