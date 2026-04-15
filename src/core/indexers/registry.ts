import type { IndexerAdapter } from './types.js';
import type { IndexerType } from '../../shared/indexer-registry.js';
import type { IndexerSettingsMap, IndexerSettings } from '../../shared/schemas/indexer.js';
import { AudioBookBayIndexer } from './abb.js';
import { NewznabIndexer } from './newznab.js';
import { TorznabIndexer } from './torznab.js';
import { MyAnonamouseIndexer } from './myanonamouse.js';
import { coerceSearchType } from '../../shared/indexer-registry.js';

const TYPED_FACTORIES: { [K in IndexerType]: (settings: IndexerSettingsMap[K], name: string, proxyUrl?: string) => IndexerAdapter } = {
  abb: (s, _name, proxyUrl) => new AudioBookBayIndexer({
    hostname: s.hostname || 'audiobookbay.lu',
    pageLimit: s.pageLimit ?? 2,
    flareSolverrUrl: s.flareSolverrUrl || undefined,
    proxyUrl,
  }),
  newznab: (s, name, proxyUrl) => new NewznabIndexer({
    apiUrl: s.apiUrl,
    apiKey: s.apiKey,
    flareSolverrUrl: s.flareSolverrUrl || undefined,
    proxyUrl,
  }, name),
  torznab: (s, name, proxyUrl) => new TorznabIndexer({
    apiUrl: s.apiUrl,
    apiKey: s.apiKey,
    flareSolverrUrl: s.flareSolverrUrl || undefined,
    proxyUrl,
  }, name),
  myanonamouse: (s, name, proxyUrl) => new MyAnonamouseIndexer({
    mamId: s.mamId,
    baseUrl: s.baseUrl || undefined,
    searchLanguages: s.searchLanguages ?? [1],
    searchType: coerceSearchType(s.searchType),
    isVip: s.isVip,
    proxyUrl,
  }, name),
};

export type IndexerAdapterFactory = (settings: IndexerSettings, name: string, proxyUrl?: string) => IndexerAdapter;

export const ADAPTER_FACTORIES: Record<IndexerType, IndexerAdapterFactory> =
  TYPED_FACTORIES as Record<IndexerType, IndexerAdapterFactory>;
