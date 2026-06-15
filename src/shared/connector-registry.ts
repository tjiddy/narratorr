import type { CreateConnectorFormData } from './schemas.js';
import type { RegistryEntry } from './registry-types.js';
import { extractHostname } from './registry-utils.js';

export const CONNECTOR_TYPES = ['audiobookshelf', 'plex'] as const;
export type ConnectorType = typeof CONNECTOR_TYPES[number];

/** Control kind a connector settings field renders as in the per-type form. */
export type ConnectorFieldType = 'text' | 'password' | 'select' | 'path-mappings' | 'toggle';

/**
 * Declarative connector settings field. The per-type form renders inputs in
 * declared order (choosing the control by `type`), and the field-error router
 * maps a `Record<string,string>` error key to the input whose `key` matches.
 */
export interface ConnectorSettingsField {
  key: string;          // settings key — also the fieldErrors Record key
  label: string;        // input label
  type: ConnectorFieldType;
  secret?: boolean;     // informational; SECRET_FIELDS still governs server-side masking
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
      { key: 'fallbackToFullRefresh', label: 'Fall back to full section refresh for unmapped paths', type: 'toggle' },
    ],
    viewSubtitle: (s) => extractHostname(s.baseUrl as string, 'Plex'),
  },
} satisfies Record<ConnectorType, ConnectorTypeMetadata>;
