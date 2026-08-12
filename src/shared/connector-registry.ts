import type { CreateConnectorFormData } from './schemas.js';
import type { RegistryEntry } from './registry-types.js';
import { extractHostname } from './registry-utils.js';

export const CONNECTOR_TYPES = ['audiobookshelf', 'plex'] as const;
export type ConnectorType = typeof CONNECTOR_TYPES[number];

export type ConnectorFieldType = 'text' | 'password' | 'select' | 'path-mappings' | 'toggle';

// Declaration order controls rendering; key also addresses fieldErrors.
export interface ConnectorSettingsField {
  key: string;
  label: string;
  type: ConnectorFieldType;
  secret?: boolean;     // Display metadata only; SECRET_FIELDS controls masking.
  placeholder?: string;
}

export type ConnectorTypeMetadata = RegistryEntry<CreateConnectorFormData['settings']> & {
  settingsFields: ConnectorSettingsField[];
};

export const CONNECTOR_REGISTRY = {
  audiobookshelf: {
    label: 'Audiobookshelf',
    defaultSettings: { baseUrl: '', apiKey: '', libraryId: '' },
    requiredFields: [
      { path: 'baseUrl', message: 'Server URL is required' },
      { path: 'apiKey', message: 'API key is required' },
      { path: 'libraryId', message: 'Library is required' },
    ],
    settingsFields: [
      { key: 'baseUrl', label: 'Server URL', type: 'text', placeholder: 'http://audiobookshelf.local:13378' },
      { key: 'apiKey', label: 'API Key', type: 'password', secret: true, placeholder: 'API key is required' },
      { key: 'libraryId', label: 'Library', type: 'select' },
    ],
    viewSubtitle: (s) => extractHostname(s.baseUrl as string, 'Audiobookshelf'),
  },
  plex: {
    label: 'Plex',
    defaultSettings: { baseUrl: '', token: '', sectionId: '', pathMappings: [], fallbackToFullRefresh: false },
    requiredFields: [
      { path: 'baseUrl', message: 'Server URL is required' },
      { path: 'token', message: 'Plex token is required' },
      { path: 'sectionId', message: 'Library section is required' },
    ],
    settingsFields: [
      { key: 'baseUrl', label: 'Server URL', type: 'text', placeholder: 'http://plex.local:32400' },
      { key: 'token', label: 'Plex Token', type: 'password', secret: true, placeholder: 'X-Plex-Token' },
      { key: 'sectionId', label: 'Library Section', type: 'select' },
      { key: 'pathMappings', label: 'Path Mappings (local → Plex server)', type: 'path-mappings' },
      { key: 'fallbackToFullRefresh', label: 'Fall back to full section refresh when a path cannot be derived', type: 'toggle' },
    ],
    viewSubtitle: (s) => extractHostname(s.baseUrl as string, 'Plex'),
  },
} satisfies Record<ConnectorType, ConnectorTypeMetadata>;
