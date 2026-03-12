import type { ImportListProvider } from './types.js';
import { AbsProvider } from './abs-provider.js';
import { NytProvider } from './nyt-provider.js';
import { HardcoverProvider } from './hardcover-provider.js';

type ProviderFactory = (settings: Record<string, unknown>) => ImportListProvider;

export const IMPORT_LIST_ADAPTER_FACTORIES: Record<string, ProviderFactory> = {
  abs: (s) => new AbsProvider({
    serverUrl: s.serverUrl as string,
    apiKey: s.apiKey as string,
    libraryId: s.libraryId as string,
  }),
  nyt: (s) => new NytProvider({
    apiKey: s.apiKey as string,
    list: (s.list as string) || 'audio-fiction',
  }),
  hardcover: (s) => new HardcoverProvider({
    apiKey: s.apiKey as string,
    listType: (s.listType as 'trending' | 'shelf') || 'trending',
    shelfId: (s.shelfId as string) || undefined,
  }),
};
