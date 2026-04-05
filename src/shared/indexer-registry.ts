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

export type MamSearchType = 'all' | 'active' | 'fl' | 'fl-VIP' | 'VIP' | 'nVIP';

/** MAM search type options — string values expected by the MAM API's `tor[searchType]` parameter. */
export const MAM_SEARCH_TYPES: ReadonlyArray<{ value: MamSearchType; label: string }> = [
  { value: 'all', label: 'All torrents' },
  { value: 'active', label: 'Only active (1+ seeders)' },
  { value: 'fl', label: 'Freeleech' },
  { value: 'fl-VIP', label: 'Freeleech or VIP' },
  { value: 'VIP', label: 'VIP only' },
  { value: 'nVIP', label: 'Not VIP' },
];

const MAM_SEARCH_TYPE_VALUES = new Set<string>(MAM_SEARCH_TYPES.map(st => st.value));

/** Legacy integer → string mapping for persisted numeric searchType values. */
const LEGACY_SEARCH_TYPE_MAP: Record<number, MamSearchType> = {
  0: 'all',
  1: 'active',
  2: 'fl',
  3: 'fl-VIP',
};

/** Coerce a persisted searchType value (possibly legacy integer) to a valid MamSearchType. */
export function coerceSearchType(value: unknown): MamSearchType {
  if (typeof value === 'string' && MAM_SEARCH_TYPE_VALUES.has(value)) return value as MamSearchType;
  if (typeof value === 'number') return LEGACY_SEARCH_TYPE_MAP[value] ?? 'active';
  return 'active';
}
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
    defaultSettings: { mamId: '', baseUrl: '', useProxy: false, searchLanguages: [1], searchType: 'active' },
    requiredFields: [
      { path: 'mamId', message: 'MAM ID is required' },
    ],
    viewSubtitle: (s) => {
      const base = (s.baseUrl as string) || 'myanonamouse.net';
      if (s.isVip === true) return `${base} — VIP`;
      if (s.isVip === false) return `${base} — User`;
      return base;
    },
  },
} satisfies Record<IndexerType, IndexerTypeMetadata>;
