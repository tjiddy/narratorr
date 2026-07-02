/**
 * Shared primary-series selection (#1088/#1097).
 *
 * The rule "prefer the singular `seriesPrimary` ref, else fall back to the first
 * element of the plural `series[]`" is a decided product behavior (#1088/#1097).
 * It was copy-pasted as the same inline nullish-coalescing expression across ~20
 * client/server/shared homes; #1097 added a "prefer `seriesPrimary`" comment
 * convention but stopped short of a helper, letting any home drift (dropping the
 * fallback, indexing differently, coercing with `||`). This is the one home so
 * every view and write path resolves the same series for a book.
 *
 * Generic over the ref element type so it works against the structurally-similar
 * but nominally-different shapes at the call sites (`MetadataSearchResultV1Source`,
 * `BookMetadata`, inline-cast objects, refs with/without `asin`, with `name`
 * optional or required). Accepts a nullish `bookLike` so sites that optional-chain
 * the metadata object itself collapse to a bare `pickPrimarySeries(meta)` with no
 * guard.
 *
 * MUST use `??` (never `||`): a ref is always a truthy object, but locking the
 * nullish semantics guards against later drift toward `||`, and keeps a
 * `position === 0` ref intact (position-0 is a valid position, not falsy-absent).
 */
export function pickPrimarySeries<T>(
  bookLike: { seriesPrimary?: T | undefined; series?: readonly T[] | undefined } | null | undefined,
): T | undefined {
  return bookLike?.seriesPrimary
    ?? bookLike?.series?.[0];
}
