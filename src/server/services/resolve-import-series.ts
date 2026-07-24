/**
 * Shared item-first series resolver (#1927).
 *
 * The confirm item's `(seriesName, seriesPosition)` pair is consumed by TWO
 * server sites — `buildBookCreatePayload` (DB-create) and `copyToLibrary`'s
 * `targetBook` (library folder path). Both must resolve the pair IDENTICALLY, so
 * the physical folder and the stored record never disagree. This is that single
 * home (the #1088/#1097/#1374/#1660 anti-drift instinct that already produced
 * `pickPrimarySeries` and `mergeMatchIntoRow`).
 *
 * Two-state, pair-locked:
 * - `seriesName` **present** (non-empty after trimming) → BOTH `name` and
 *   `position` come from the ITEM. Trimming ONLY classifies present-vs-absent —
 *   the returned name is the item's original string, unmodified (a padded
 *   `" Saga "` is preserved verbatim; the folder-path renderer's existing
 *   `sanitizePath` is the sole normalizer on disk, unchanged by this work). A
 *   user series with no position gets series-with-no-position — position never
 *   crosses sources.
 * - `seriesName` **absent** (omitted / empty / whitespace-only) → BOTH fields
 *   defer to the matched metadata's primary series. Callers pass
 *   `pickPrimarySeries(meta)` as `primary`, which prefers `seriesPrimary` over
 *   `series[0]` (#1088/#1097) and uses `??` so a `position === 0` primary
 *   survives. An item-supplied position on an absent name is intentionally
 *   dropped (pair-lock), never borrowed onto the metadata name.
 *
 * This is the AUTHORITATIVE classification point (AC5): it holds for every
 * caller — the staged PUT body and already-persisted payloads accept any string
 * (`z.string().optional()`), so a non-React caller can submit `seriesName: "   "`;
 * the resolver classifies it absent before deciding. The client mapper
 * (`toConfirmItem`) applies the same classification early for a clean wire
 * payload, but that is a UX safeguard, not the contract boundary.
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
  // Classify by trim (present-vs-absent) but never rewrite a present value.
  if (item.seriesName?.trim()) {
    return { name: item.seriesName, position: item.seriesPosition };
  }
  return { name: primary?.name, position: primary?.position };
}
