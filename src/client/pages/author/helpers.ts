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

  for (const book of books) {
    const s = book.series?.[0];
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
        const posA = a.series?.[0]?.position ?? Infinity;
        const posB = b.series?.[0]?.position ?? Infinity;
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
