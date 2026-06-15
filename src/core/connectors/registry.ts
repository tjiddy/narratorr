import type { ConnectorAdapter } from './types.js';
import type { ConnectorType } from '../../shared/connector-registry.js';
import type { ConnectorSettingsMap, ConnectorSettings } from '../../shared/schemas/connector.js';
import { AudiobookshelfConnector } from './abs.js';

const TYPED_FACTORIES: { [K in ConnectorType]: (settings: ConnectorSettingsMap[K]) => ConnectorAdapter } = {
  audiobookshelf: (s) => new AudiobookshelfConnector({
    baseUrl: s.baseUrl,
    apiKey: s.apiKey,
    libraryId: s.libraryId,
  }),
};

export type ConnectorAdapterFactory = (settings: ConnectorSettings) => ConnectorAdapter;

export const ADAPTER_FACTORIES: Record<ConnectorType, ConnectorAdapterFactory> =
  TYPED_FACTORIES as Record<ConnectorType, ConnectorAdapterFactory>;
