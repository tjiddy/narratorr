import type { BookSortField, BookSortDirection } from '../../shared/schemas/book.js';
import type { LibraryBookListItemRow } from './book-list.service.js';
import { toSortTitle } from '../../core/utils/naming.js';
import { resolveBookQualityInputs } from '../../core/utils/quality.js';

type SortKeyExtractor = (row: LibraryBookListItemRow) => string | number | null;

function qualitySortKey(row: LibraryBookListItemRow): number | null {
  const { sizeBytes, durationSeconds } = resolveBookQualityInputs(row);
  if (!sizeBytes || !durationSeconds) return null;
  return sizeBytes / durationSeconds;
}

function titleSortKey(row: LibraryBookListItemRow): string {
  const isCollapsed = row.collapsedCount != null;
  if (isCollapsed && row.seriesName) return toSortTitle(row.seriesName);
  return toSortTitle(row.title);
}

const SORT_KEY_EXTRACTORS: Record<string, SortKeyExtractor> = {
  title: titleSortKey,
  author: (row) => row.authors[0]?.name ?? null,
  narrator: (row) => row.narrators[0]?.name ?? null,
  series: (row) => row.seriesName ?? null,
  quality: qualitySortKey,
  size: (row) => row.audioTotalSize ?? row.size ?? null,
  format: (row) => row.audioFileFormat ?? null,
  createdAt: (row) => row.createdAt.getTime(),
};

function collapsedSortKey(row: LibraryBookListItemRow, field?: BookSortField): string | number | null {
  const extractor = (field && SORT_KEY_EXTRACTORS[field]) ?? SORT_KEY_EXTRACTORS.createdAt!;
  return extractor(row);
}

export function sortCollapsedRows(rows: LibraryBookListItemRow[], sortField?: BookSortField, sortDirection?: BookSortDirection): void {
  const dir = sortDirection === 'asc' ? 1 : -1;
  rows.sort((a, b) => {
    const aKey = collapsedSortKey(a, sortField);
    const bKey = collapsedSortKey(b, sortField);
    if (aKey === null && bKey === null) return 0;
    if (aKey === null) return 1;
    if (bKey === null) return -1;
    let cmp: number;
    if (typeof aKey === 'string' && typeof bKey === 'string') {
      cmp = aKey.localeCompare(bKey);
    } else {
      cmp = (aKey as number) - (bKey as number);
    }
    if (cmp !== 0) return cmp * dir;
    const idCmp = a.id - b.id;
    return idCmp * dir;
  });
}

export function buildFallbackCompare(
  sortField?: BookSortField,
  sortDirection?: BookSortDirection,
): ((a: { audioTotalSize: number | null; size: number | null; audioDuration: number | null; duration: number | null; id: number }, b: typeof a) => number) | undefined {
  if (sortField !== 'quality') return undefined;
  const dir = sortDirection === 'asc' ? 1 : -1;
  return (a, b) => {
    const aq = resolveBookQualityInputs(a);
    const bq = resolveBookQualityInputs(b);
    const aVal = aq.sizeBytes && aq.durationSeconds ? aq.sizeBytes / aq.durationSeconds : null;
    const bVal = bq.sizeBytes && bq.durationSeconds ? bq.sizeBytes / bq.durationSeconds : null;
    if (aVal === null && bVal === null) return 0;
    if (aVal === null) return 1;
    if (bVal === null) return -1;
    const cmp = (aVal - bVal) * dir;
    return cmp !== 0 ? cmp : (a.id - b.id) * dir;
  };
}

export function collapseRows<T extends { id: number; seriesName: string | null; seriesPosition: number | null }>(
  allRows: T[],
  fallbackCompare?: (a: T, b: T) => number,
): { representativeIndices: number[]; collapsedCounts: Map<number, number> } {
  const seriesGroups = new Map<string, number[]>();
  const standaloneIndices: number[] = [];

  for (let i = 0; i < allRows.length; i++) {
    const row = allRows[i]!;
    if (row.seriesName) {
      const group = seriesGroups.get(row.seriesName);
      if (group) {
        group.push(i);
      } else {
        seriesGroups.set(row.seriesName, [i]);
      }
    } else {
      standaloneIndices.push(i);
    }
  }

  const representativeIndices: number[] = [...standaloneIndices];
  const collapsedCounts = new Map<number, number>();

  for (const [, indices] of seriesGroups) {
    const withPosition = indices.filter((i) => allRows[i]!.seriesPosition != null);
    let repIdx: number;
    if (withPosition.length > 0) {
      repIdx = withPosition.reduce((bestIdx, idx) =>
        allRows[idx]!.seriesPosition! < allRows[bestIdx]!.seriesPosition! ? idx : bestIdx,
      );
    } else if (fallbackCompare) {
      repIdx = [...indices].sort((ai, bi) => fallbackCompare(allRows[ai]!, allRows[bi]!))[0]!;
    } else {
      repIdx = indices[0]!;
    }
    representativeIndices.push(repIdx);
    collapsedCounts.set(allRows[repIdx]!.id, indices.length - 1);
  }

  return { representativeIndices, collapsedCounts };
}
