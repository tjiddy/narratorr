export function pickPrimarySeries<T>(
  bookLike: { seriesPrimary?: T | undefined; series?: readonly T[] | undefined } | null | undefined,
): T | undefined {
  return bookLike?.seriesPrimary
    ?? bookLike?.series?.[0];
}
