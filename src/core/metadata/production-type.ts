import type { ProductionType } from '@shared/schemas/book.js';

/**
 * Uses only provider `formatType`; `contentDeliveryType` describes part count, not production form.
 * Only abridged and unabridged map through; all other values, including reserved enum values, are unknown.
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
