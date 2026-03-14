import type { CreateIndexerFormData } from './schemas.js';
import type { RegistryEntry } from './registry-types.js';

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
    defaultSettings: { mamId: '', baseUrl: '', useProxy: false },
    requiredFields: [
      { path: 'mamId', message: 'MAM ID is required' },
    ],
    viewSubtitle: (s) => (s.baseUrl as string) || 'myanonamouse.net',
  },
};
