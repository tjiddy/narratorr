export const HARDCOVER_LIST_TYPES = ['trending', 'shelf', 'custom'] as const;
export type HardcoverListType = typeof HARDCOVER_LIST_TYPES[number];

// all still uses bounded pagination; numeric values are fixed limits.
export const HARDCOVER_IMPORT_MAX_VALUES = [50, 100, 'all'] as const;
export type HardcoverImportMax = typeof HARDCOVER_IMPORT_MAX_VALUES[number];
