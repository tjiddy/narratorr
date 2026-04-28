import type { ImportListProvider } from './types.js';
import type { ImportListType } from '../../shared/import-list-registry.js';
import type { ImportListSettingsMap, ImportListSettings } from '../../shared/schemas/import-list.js';
import { AbsProvider } from './abs-provider.js';
import { NytProvider } from './nyt-provider.js';
import { HardcoverProvider } from './hardcover-provider.js';

const TYPED_FACTORIES: { [K in ImportListType]: (settings: ImportListSettingsMap[K]) => ImportListProvider } = {
  abs: (s) => new AbsProvider({
    serverUrl: s.serverUrl,
    apiKey: s.apiKey,
    libraryId: s.libraryId,
  }),
  nyt: (s) => new NytProvider({
    apiKey: s.apiKey,
    list: s.list || 'audio-fiction',
  }),
  hardcover: (s) => new HardcoverProvider({
    apiKey: s.apiKey,
    listType: s.listType || 'trending',
    shelfId: s.shelfId,
  }),
};

export type ImportListProviderFactory = (settings: ImportListSettings) => ImportListProvider;

export const IMPORT_LIST_ADAPTER_FACTORIES: Record<ImportListType, ImportListProviderFactory> =
  TYPED_FACTORIES as Record<ImportListType, ImportListProviderFactory>;
