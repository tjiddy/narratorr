import type { IndexerAdapter } from './types.js';
import { AudioBookBayIndexer } from './abb.js';
import { NewznabIndexer } from './newznab.js';
import { TorznabIndexer } from './torznab.js';
import { MyAnonamouseIndexer } from './myanonamouse.js';

type AdapterFactory = (settings: Record<string, unknown>, name: string, proxyUrl?: string) => IndexerAdapter;

export const ADAPTER_FACTORIES: Record<string, AdapterFactory> = {
  abb: (s, _name, proxyUrl) => new AudioBookBayIndexer({
    hostname: (s.hostname as string) || 'audiobookbay.lu',
    pageLimit: (s.pageLimit as number) || 2,
    flareSolverrUrl: (s.flareSolverrUrl as string) || undefined,
    proxyUrl,
  }),
  newznab: (s, name, proxyUrl) => new NewznabIndexer({
    apiUrl: s.apiUrl as string,
    apiKey: s.apiKey as string,
    flareSolverrUrl: (s.flareSolverrUrl as string) || undefined,
    proxyUrl,
  }, name),
  torznab: (s, name, proxyUrl) => new TorznabIndexer({
    apiUrl: s.apiUrl as string,
    apiKey: s.apiKey as string,
    flareSolverrUrl: (s.flareSolverrUrl as string) || undefined,
    proxyUrl,
  }, name),
  myanonamouse: (s, name, proxyUrl) => new MyAnonamouseIndexer({
    mamId: s.mamId as string,
    baseUrl: (s.baseUrl as string) || undefined,
    searchLanguages: (s.searchLanguages as number[]) ?? [1],
    searchType: (s.searchType as number) ?? 1,
    proxyUrl,
  }, name),
};
