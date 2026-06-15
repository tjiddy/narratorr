import type { CreateConnectorFormData } from './schemas.js';
import type { RegistryEntry } from './registry-types.js';
import { extractHostname } from './registry-utils.js';

export const CONNECTOR_TYPES = ['audiobookshelf'] as const;
export type ConnectorType = typeof CONNECTOR_TYPES[number];

export type ConnectorTypeMetadata = RegistryEntry<CreateConnectorFormData['settings']>;

export const CONNECTOR_REGISTRY = {
  audiobookshelf: {
    label: 'Audiobookshelf',
    defaultSettings: { baseUrl: '', apiKey: '', libraryId: '' },
    requiredFields: [
      { path: 'baseUrl', message: 'Server URL is required' },
      { path: 'apiKey', message: 'API key is required' },
      { path: 'libraryId', message: 'Library is required' },
    ],
    viewSubtitle: (s) => extractHostname(s.baseUrl as string, 'Audiobookshelf'),
  },
} satisfies Record<ConnectorType, ConnectorTypeMetadata>;
