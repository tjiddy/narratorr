import type { MetadataSearchProvider } from './types.js';
import { AudibleProvider } from './audible.js';

type SearchProviderFactory = (config: Record<string, unknown>) => MetadataSearchProvider;

export const METADATA_SEARCH_PROVIDER_FACTORIES: Record<string, SearchProviderFactory> = {
  audible: (config) => {
    const region = (config.region as string) || undefined;
  return new AudibleProvider(region !== undefined ? { region } : {});
  },
};
