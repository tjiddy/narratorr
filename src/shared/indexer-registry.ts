import type { CreateIndexerFormData } from './schemas.js';
import type { RegistryEntry } from './registry-types.js';

export const INDEXER_TYPES = ['abb', 'torznab', 'newznab', 'myanonamouse'] as const;

/** MAM language codes — numeric IDs used by the MAM API's `tor[browse_lang]` parameter. */
export const MAM_LANGUAGES: ReadonlyArray<{ id: number; label: string }> = [
  { id: 1, label: 'English' },
  { id: 2, label: 'Chinese' },
  { id: 4, label: 'Spanish' },
  { id: 33, label: 'Italian' },
  { id: 35, label: 'Dutch' },
  { id: 36, label: 'French' },
  { id: 37, label: 'German' },
  { id: 38, label: 'Japanese' },
  { id: 40, label: 'Korean' },
  { id: 43, label: 'Norwegian' },
  { id: 44, label: 'Polish' },
  { id: 45, label: 'Portuguese' },
  { id: 46, label: 'Russian' },
  { id: 49, label: 'Swedish' },
  { id: 51, label: 'Turkish' },
];

/** MAM search type options — maps to the `tor[searchType]` API parameter. */
export const MAM_SEARCH_TYPES: ReadonlyArray<{ value: number; label: string }> = [
  { value: 0, label: 'All torrents' },
  { value: 1, label: 'Only active (1+ seeders)' },
  { value: 2, label: 'Freeleech' },
  { value: 3, label: 'Freeleech or VIP' },
];
export type IndexerType = typeof INDEXER_TYPES[number];

type IndexerTypeMetadata = RegistryEntry<CreateIndexerFormData['settings']>;

export const INDEXER_REGISTRY: Record<string, IndexerTypeMetadata> = {
  abb: {
    label: 'AudioBookBay',
    defaultSettings: { hostname: '', pageLimit: 2, flareSolverrUrl: '', useProxy: false },
    requiredFields: [{ path: 'hostname', message: 'Hostname is required' }],
    viewSubtitle: (s) => (s.hostname as string) || 'abb',
  },
  torznab: {
    label: 'Torznab',
    defaultSettings: { apiUrl: '', apiKey: '', flareSolverrUrl: '', useProxy: false },
    requiredFields: [
      { path: 'apiUrl', message: 'API URL is required' },
      { path: 'apiKey', message: 'API key is required' },
    ],
    viewSubtitle: (s) => (s.apiUrl as string) || 'torznab',
  },
  newznab: {
    label: 'Newznab',
    defaultSettings: { apiUrl: '', apiKey: '', flareSolverrUrl: '', useProxy: false },
    requiredFields: [
      { path: 'apiUrl', message: 'API URL is required' },
      { path: 'apiKey', message: 'API key is required' },
    ],
    viewSubtitle: (s) => (s.apiUrl as string) || 'newznab',
  },
  myanonamouse: {
    label: 'MyAnonamouse',
    defaultSettings: { mamId: '', baseUrl: '', useProxy: false, searchLanguages: [1], searchType: 1 },
    requiredFields: [
      { path: 'mamId', message: 'MAM ID is required' },
    ],
    viewSubtitle: (s) => (s.baseUrl as string) || 'myanonamouse.net',
  },
} satisfies Record<IndexerType, IndexerTypeMetadata>;
