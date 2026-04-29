import type { CreateImportListFormData } from './schemas.js';
import type { RegistryEntry } from './registry-types.js';

export const IMPORT_LIST_TYPES = ['abs', 'nyt', 'hardcover'] as const;
export type ImportListType = typeof IMPORT_LIST_TYPES[number];

export type ImportListTypeMetadata = RegistryEntry<CreateImportListFormData['settings']>;

export const IMPORT_LIST_REGISTRY = {
  abs: {
    label: 'Audiobookshelf',
    defaultSettings: { serverUrl: '', apiKey: '', libraryId: '' },
    requiredFields: [
      { path: 'serverUrl', message: 'Server URL is required' },
      { path: 'apiKey', message: 'API key is required' },
      { path: 'libraryId', message: 'Library is required' },
    ],
    viewSubtitle: (s) => (s.serverUrl as string) || 'abs',
  },
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
