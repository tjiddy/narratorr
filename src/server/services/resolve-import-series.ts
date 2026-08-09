/**
 * Resolve name and position as an inseparable pair for both DB and folder paths. A nonblank item
 * name wins verbatim with its position; otherwise both fields come from primary metadata.
 */

interface SeriesRefLike {
  name?: string | undefined;
  position?: number | undefined;
}

interface ImportSeriesFields {
  seriesName?: string | null | undefined;
  seriesPosition?: number | undefined;
}

export interface ResolvedImportSeries {
  name: string | undefined;
  position: number | undefined;
}

export function resolveImportSeries(
  item: ImportSeriesFields,
  primary: SeriesRefLike | undefined,
): ResolvedImportSeries {
  // Trim only to classify presence; preserve a present value verbatim.
  if (item.seriesName?.trim()) {
    return { name: item.seriesName, position: item.seriesPosition };
  }
  return { name: primary?.name, position: primary?.position };
}
