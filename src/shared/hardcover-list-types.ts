// Single source of truth for the Hardcover list-type discriminant, shared by the
// provider config/state (core) and the settings + form Zod enums (shared), so the
// contracts cannot drift when a variant is added (#1879 DRY-1). Mirrors the
// IMPORT_LIST_TYPES → importListTypeSchema pattern in import-list-registry.ts.
export const HARDCOVER_LIST_TYPES = ['trending', 'shelf', 'custom'] as const;
export type HardcoverListType = typeof HARDCOVER_LIST_TYPES[number];

// Single source of truth for the custom-list "Import Max" closed set, shared by
// the settings Zod schema (built via z.literal on this tuple), the shared
// settings type, and the provider config/state — so the four contracts cannot
// drift (#1879 DRY-1, mirrors HARDCOVER_LIST_TYPES). `50`/`100` = a fixed limit;
// `'all'` = bounded pagination.
export const HARDCOVER_IMPORT_MAX_VALUES = [50, 100, 'all'] as const;
export type HardcoverImportMax = typeof HARDCOVER_IMPORT_MAX_VALUES[number];
