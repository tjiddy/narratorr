import type { ProductionType } from '../../shared/schemas/book.js';

/**
 * Map a provider `formatType` to the canonical `production_type` column value
 * (#1710, Multiple Narrations 1/3).
 *
 * `BookMetadata.formatType` is the ONLY input — `contentDeliveryType`
 * (`SinglePartBook`/`MultiPartBook`) encodes part-count, not production form, and
 * is intentionally excluded. Audible supplies `format_type` (`unabridged`/
 * `abridged`, mixed case — hence the lowercase + trim); Audnexus maps no format
 * field, so it arrives `undefined`.
 *
 * Total and exhaustive: only `unabridged`/`abridged` map through; every other,
 * empty, `null`, or `undefined` value folds to `unknown`. The reserved values
 * (`full_cast`/`dramatized`/`graphic_audio`) are valid enum members but are never
 * produced here today — no provider field surfaces them (full-cast *detection for
 * dedup* is the narrator predicate's job, not this column's). Accepts
 * `string | null | undefined` by contract (zod-nullish-external-api) so a
 * provider returning `null` is handled rather than throwing.
 */
export function normalizeProductionType(formatType: string | null | undefined): ProductionType {
  switch (formatType?.trim().toLowerCase()) {
    case 'unabridged':
      return 'unabridged';
    case 'abridged':
      return 'abridged';
    default:
      return 'unknown';
  }
}
