import type { IndexerAdapter } from './types.js';
import { AudioBookBayIndexer } from './abb.js';
import { NewznabIndexer } from './newznab.js';
import { TorznabIndexer } from './torznab.js';
import { MyAnonamouseIndexer } from './myanonamouse.js';

type AdapterFactory = (settings: Record<string, unknown>, name: string) => IndexerAdapter;

export const ADAPTER_FACTORIES: Record<string, AdapterFactory> = {
  abb: (s) => new AudioBookBayIndexer({
    hostname: (s.hostname as string) || 'audiobookbay.lu',
    pageLimit: (s.pageLimit as number) || 2,
    flareSolverrUrl: (s.flareSolverrUrl as string) || undefined,
  }),
  newznab: (s, name) => new NewznabIndexer({
    apiUrl: s.apiUrl as string,
    apiKey: s.apiKey as string,
    flareSolverrUrl: (s.flareSolverrUrl as string) || undefined,
  }, name),
  torznab: (s, name) => new TorznabIndexer({
    apiUrl: s.apiUrl as string,
    apiKey: s.apiKey as string,
    flareSolverrUrl: (s.flareSolverrUrl as string) || undefined,
  }, name),
  myanonamouse: (s, name) => new MyAnonamouseIndexer({
    mamId: s.mamId as string,
    baseUrl: (s.baseUrl as string) || undefined,
  }, name),
};
