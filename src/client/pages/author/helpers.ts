import type { BookMetadata } from '@/lib/api';

export function getInitials(name: string): string {
  return name
    .split(/\s+/)
    .slice(0, 2)
    .map((w) => w[0])
    .join('')
    .toUpperCase();
}

export interface SeriesGroup {
  name: string;
  books: BookMetadata[];
}

export function groupBooksBySeries(books: BookMetadata[]): { series: SeriesGroup[]; standalone: BookMetadata[] } {
  const seriesMap = new Map<string, BookMetadata[]>();
  const standalone: BookMetadata[] = [];

  // Prefer canonical `seriesPrimary` over `series[0]` (#1088 / #1097) so books
  // are grouped under their real series, not a broader universe entry.
  const primaryRef = (b: BookMetadata) => b.seriesPrimary ?? b.series?.[0];

  for (const book of books) {
    const s = primaryRef(book);
    if (s?.name) {
      const existing = seriesMap.get(s.name) ?? [];
      existing.push(book);
      seriesMap.set(s.name, existing);
    } else {
      standalone.push(book);
    }
  }

  const series = Array.from(seriesMap.entries())
    .map(([name, seriesBooks]) => ({
      name,
      books: seriesBooks.sort((a, b) => {
        const posA = primaryRef(a)?.position ?? Infinity;
        const posB = primaryRef(b)?.position ?? Infinity;
        return posA - posB;
      }),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));

  standalone.sort((a, b) => {
    const dateA = a.publishedDate;
    const dateB = b.publishedDate;
    if (!dateA && !dateB) return 0;
    if (!dateA) return 1;
    if (!dateB) return -1;
    return dateB.localeCompare(dateA);
  });

  return { series, standalone };
}

export const BIO_COLLAPSE_LENGTH = 300;
