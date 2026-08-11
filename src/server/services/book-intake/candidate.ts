import type { DuplicateCandidate } from '../book-dedup.js';
import type { IntakeItem } from './types.js';

/** Project an item onto the duplicate primitive's candidate shape. Absence is a signal the resolver
 * reads (an omitted narrator list is not an empty one), so an omitted field stays omitted — never
 * defaulted to null, [], 0 or a placeholder. Falsy supplied values pass through untouched. */
export function buildDuplicateCandidate(item: IntakeItem): DuplicateCandidate {
  return {
    title: item.title,
    ...(item.authors !== undefined && { authors: item.authors }),
    ...(item.asin !== undefined && { asin: item.asin }),
    ...(item.narrators !== undefined && { narrators: item.narrators }),
    ...(item.duration !== undefined && { duration: item.duration }),
    ...(item.productionType !== undefined && { productionType: item.productionType }),
  };
}
