import type { CreateImportListFormData } from './schemas.js';

interface RequiredField {
  path: string;
  message: string;
}

interface ImportListTypeMetadata {
  label: string;
  defaultSettings: CreateImportListFormData['settings'];
  requiredFields: RequiredField[];
  viewSubtitle: (settings: Record<string, unknown>) => string;
}

export const IMPORT_LIST_REGISTRY: Record<string, ImportListTypeMetadata> = {
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
    defaultSettings: { apiKey: '', listType: 'trending', shelfId: '' },
    requiredFields: [
      { path: 'apiKey', message: 'API key is required' },
    ],
    viewSubtitle: (s) => (s.listType as string) || 'trending',
  },
};
