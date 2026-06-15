import type { ConnectorAdapter } from './types.js';
import type { ConnectorType } from '../../shared/connector-registry.js';
import type { ConnectorSettingsMap, ConnectorSettings } from '../../shared/schemas/connector.js';
import { AudiobookshelfConnector } from './abs.js';
import { PlexConnector } from './plex.js';

const TYPED_FACTORIES: { [K in ConnectorType]: (settings: ConnectorSettingsMap[K]) => ConnectorAdapter } = {
  audiobookshelf: (s) => new AudiobookshelfConnector({
    baseUrl: s.baseUrl,
    apiKey: s.apiKey,
    libraryId: s.libraryId,
  }),
  plex: (s) => new PlexConnector({
    baseUrl: s.baseUrl,
    token: s.token,
    sectionId: s.sectionId,
    pathMappings: s.pathMappings,
    fallbackToFullRefresh: s.fallbackToFullRefresh,
  }),
};

export type ConnectorAdapterFactory = (settings: ConnectorSettings) => ConnectorAdapter;

export const ADAPTER_FACTORIES: Record<ConnectorType, ConnectorAdapterFactory> =
  TYPED_FACTORIES as Record<ConnectorType, ConnectorAdapterFactory>;
