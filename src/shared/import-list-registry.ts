import type { CreateImportListFormData } from './schemas.js';
import type { RegistryEntry } from './registry-types.js';

export const IMPORT_LIST_TYPES = ['nyt', 'hardcover'] as const;
export type ImportListType = typeof IMPORT_LIST_TYPES[number];

export type ImportListTypeMetadata = RegistryEntry<CreateImportListFormData['settings']>;

export const IMPORT_LIST_REGISTRY = {
  nyt: {
    label: 'NYT Bestsellers',
    defaultSettings: { apiKey: '', list: 'audio-fiction' },
    requiredFields: [
      { path: 'apiKey', message: 'API key is required' },
    ],
    viewSubtitle: (s) => (s.list as string) || 'audio-fiction',
  },
  hardcover: {
    label: 'Hardcover',
    defaultSettings: { apiKey: '', listType: 'trending' },
    requiredFields: [
      { path: 'apiKey', message: 'API key is required' },
    ],
    viewSubtitle: (s) => (s.listType as string) || 'trending',
  },
} satisfies Record<ImportListType, ImportListTypeMetadata>;
