// Single source of truth for the Hardcover list-type discriminant, shared by the
// provider config/state (core) and the settings + form Zod enums (shared), so the
// contracts cannot drift when a variant is added (#1879 DRY-1). Mirrors the
// IMPORT_LIST_TYPES → importListTypeSchema pattern in import-list-registry.ts.
export const HARDCOVER_LIST_TYPES = ['trending', 'shelf', 'custom'] as const;
export type HardcoverListType = typeof HARDCOVER_LIST_TYPES[number];
